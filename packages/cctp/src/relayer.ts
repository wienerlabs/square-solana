// CCTP relayer (BE-26): kayıtlı burn'leri sonuçlanana kadar izler. Her tur zamanı gelmiş açık transferleri
// (`store.due`) sırayla bir adım ilerletir:
// - `pendingAttestation`: Circle'ın servisine bakılır. İmzalanınca mesaj doğrulanır (hedef Solana, kaynak kayıttaki
//   domain, mint alıcısı kurumun USDC hesabı, teslim eden sınırlanmamış ya da kurum) ve `attested` yazılır; mesaj
//   bu job'u fonlayamıyorsa `failed`.
// - `attested`: nonce hesabı varsa mesaj teslim edilmiştir (kurumun tek tx'i, relayer ya da başkası): `received`.
//   Yoksa kurumun mint + fonlama tx'i `relayAfterSeconds` boyunca beklenir; süre dolunca relayer mesajı kendisi
//   teslim eder (`receive_message`, ücreti ve gerekirse kurumun USDC hesabının rent'ini relayer öder). USDC kurumun
//   hesabına mint edilir; fonlamayı yine kurum imzalar.
// - `received`: job `Open`'dan çıktıysa fonlama tx'i job'un imzalarında aranır: `funded`. Job fonlanmadan iptal
//   edildiyse `failed` (USDC kurumun hesabında kalır).
// Bekleme ve hata bir sonraki bakışı geri çekilmeyle ileri atar (`attempts`, `nextAttemptAt`); durum değişince
// sayaç sıfırlanır. Her adım zincirden ya da Circle'dan yeniden okur: yarıda kalan tur (gönderilip yazılamayan tx)
// bir sonraki turda nonce hesabından anlaşılır, aynı mesaj ikinci kez gönderilmez.
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Keypair } from '@solana/web3.js';
import {
  CCTP_RECEIVE_COMPUTE_UNITS,
  CCTP_SOLANA_DOMAIN,
  cctpUsedNonceAddress,
  decodeCctpMessage,
  fetchCctpAttestation,
  isCctpNonceUsed,
  receiveMessageInstruction,
  type CctpMessage,
} from '@squaresdk/solana-sdk';
import type { CctpTransferStatus } from '@squaresdk/solana-types';
import { hexToBytes, receiveContext, settlementReader, type CctpEnvironment, type Settlement } from './environment.js';
import type { TransferPatch, TransferRow, TransferStore } from './store.js';

const MS_PER_SECOND = 1000;
/** Nonce hesabının ve job'un imzalarında geriye bakılan en fazla kayıt. */
const SIGNATURE_WINDOW = 50;
const FUND_JOB_LOG = 'Program log: Instruction: FundJob';

export interface RelayerDeps {
  readonly env: CctpEnvironment;
  readonly store: TransferStore;
  /** Relayer cüzdanı: teslim tx'inin ücretini ve gerekirse kurumun USDC hesabının rent'ini öder. */
  readonly payer: Keypair;
  /** Circle'ın attestation servisi (`https://iris-api(-sandbox).circle.com`). */
  readonly attestationApi: string;
  /** Kurumun mint + fonlama tx'i için beklenen süre; dolunca relayer mesajı kendisi teslim eder. */
  readonly relayAfterSeconds: number;
  readonly backoff: { readonly baseSeconds: number; readonly maxSeconds: number };
  readonly batchSize: number;
  readonly confirmPollMs: number;
  /** Teslim tx'inin priority fee'si (mikro-lamport / CU), yazılabilir hesaplarına göre. */
  readonly computeUnitPrice: (writable: readonly PublicKey[]) => Promise<bigint>;
  readonly settlement?: () => Promise<Settlement>;
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
  readonly onTransition?: (from: CctpTransferStatus, to: CctpTransferStatus, transfer: TransferRow) => void;
  readonly onError?: (error: unknown, transfer: TransferRow) => void;
}

export interface RelayerRound {
  readonly evaluated: number;
  readonly transitions: number;
  readonly errors: number;
}

export interface CctpRelayer {
  runOnce(): Promise<RelayerRound>;
}

/** Mesaj bu job'u fonlayamıyorsa sebebi; fonlayabiliyorsa null. */
export function rejection(row: TransferRow, message: CctpMessage): string | null {
  if (message.destinationDomain !== CCTP_SOLANA_DOMAIN) {
    return `mesajın hedefi Solana değil (domain ${message.destinationDomain})`;
  }
  if (message.sourceDomain !== row.sourceDomain) {
    return `mesajın kaynak domain'i ${message.sourceDomain}, kayıttaki ${row.sourceDomain}`;
  }
  if (message.burn.mintRecipient.toBase58() !== row.mintRecipient) {
    return `mint alıcısı ${message.burn.mintRecipient.toBase58()}, kurumun USDC hesabı ${row.mintRecipient}: USDC o hesaba mint edilir, bu job'u fonlayamaz`;
  }
  const caller = new PublicKey(message.destinationCaller);
  if (!caller.equals(PublicKey.default) && caller.toBase58() !== row.institution) {
    return `mesajı yalnızca ${caller.toBase58()} teslim edebilir (destinationCaller); kurum değil`;
  }
  if (message.burn.feeExecuted > message.burn.amount) return 'alınan ücret yakılan tutardan büyük';
  return null;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCctpRelayer(deps: RelayerDeps): CctpRelayer {
  const { env, store, payer } = deps;
  const { connection } = env;
  const clock = deps.clock ?? Date.now;
  const settlement = deps.settlement ?? settlementReader(env);

  const later = (row: TransferRow, now: number): Date => {
    const seconds = Math.min(deps.backoff.maxSeconds, deps.backoff.baseSeconds * 2 ** Math.min(row.attempts, 30));
    return new Date(now + seconds * MS_PER_SECOND);
  };

  /** Bekleme ya da hata: aynı durumda kalır, bir sonraki bakış ileri atılır. */
  const wait = (row: TransferRow, now: number, error: string | null = null): TransferPatch => ({
    attempts: row.attempts + 1,
    nextAttemptAt: later(row, now),
    error,
  });

  const advance = (status: CctpTransferStatus, patch: TransferPatch = {}): TransferPatch => ({
    status,
    attempts: 0,
    nextAttemptAt: null,
    error: null,
    ...patch,
  });

  /** Adresin en eski başarılı imzası (nonce hesabını açan teslim tx'i). */
  async function oldestSignature(address: PublicKey): Promise<string | null> {
    const signatures = await connection.getSignaturesForAddress(address, { limit: SIGNATURE_WINDOW }, 'confirmed');
    return signatures.filter((entry) => entry.err === null).at(-1)?.signature ?? null;
  }

  /** Job'u fonlayan tx: imzaları eskiden yeniye, `fund_job` talimatını içeren ilk başarılı tx. */
  async function fundSignature(job: PublicKey): Promise<string | null> {
    const signatures = await connection.getSignaturesForAddress(job, { limit: SIGNATURE_WINDOW }, 'confirmed');
    for (const entry of signatures.filter((candidate) => candidate.err === null).reverse()) {
      const tx = await connection.getTransaction(entry.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages?.includes(FUND_JOB_LOG)) return entry.signature;
    }
    return null;
  }

  async function confirm(signature: string, lastValidBlockHeight: number): Promise<unknown> {
    for (;;) {
      const [status] = (await connection.getSignatureStatuses([signature])).value;
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        return status.err;
      }
      if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
        throw new Error(`tx onaylanmadan blockhash'in süresi doldu: ${signature}`);
      }
      await new Promise((resolve) => setTimeout(resolve, deps.confirmPollMs));
    }
  }

  /** `receive_message`'ı relayer gönderir; mesaj bu arada teslim edildiyse onu bulan imzayı döner. */
  async function deliver(row: TransferRow, message: CctpMessage): Promise<string | null> {
    const table = env.cctpLookupTables.get(row.sourceDomain);
    if (!table) throw new Error(`kaynak domain ${row.sourceDomain} için CCTP ALT'ı yapılandırılmamış`);
    const usdc = await settlement();
    const institution = new PublicKey(row.institution);
    const recipient = getAssociatedTokenAddressSync(usdc.mint, institution, true, usdc.tokenProgram);
    const prepend = (await connection.getAccountInfo(recipient, 'confirmed'))
      ? []
      : [
          createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            recipient,
            institution,
            usdc.mint,
            usdc.tokenProgram,
          ),
        ];
    const receive = receiveMessageInstruction({
      context: await receiveContext(env, usdc, message),
      message: hexToBytes(row.message!),
      attestation: hexToBytes(row.attestation!),
      payer: payer.publicKey,
      caller: payer.publicKey,
    });
    const usedNonce = cctpUsedNonceAddress(env.programs, message.nonce);
    const built = await env.client.buildTx([...prepend, receive], {
      feePayer: payer.publicKey,
      computeUnitLimit: CCTP_RECEIVE_COMPUTE_UNITS,
      computeUnitPrice: await deps.computeUnitPrice([usedNonce, recipient]),
      addressLookupTables: [...(env.squareLookupTable ? [env.squareLookupTable] : []), table],
    });
    built.transaction.sign([payer]);
    const simulation = await connection.simulateTransaction(built.transaction, { commitment: 'confirmed' });
    if (simulation.value.err !== null) {
      if (await isCctpNonceUsed(connection, env.programs, message.nonce)) return oldestSignature(usedNonce);
      const logs = (simulation.value.logs ?? []).slice(-4).join(' | ');
      throw new Error(`receive_message simülasyonu başarısız: ${JSON.stringify(simulation.value.err)} ${logs}`);
    }
    const signature = await connection.sendRawTransaction(built.transaction.serialize(), { skipPreflight: true });
    const err = await confirm(signature, built.lastValidBlockHeight);
    if (err !== null) throw new Error(`receive_message zincirde başarısız: ${signature} ${JSON.stringify(err)}`);
    return signature;
  }

  async function awaitingAttestation(row: TransferRow, now: number): Promise<TransferPatch> {
    const lookup = await fetchCctpAttestation({
      api: deps.attestationApi,
      sourceDomain: row.sourceDomain,
      transactionHash: row.sourceTxHash,
      ...(deps.fetch && { fetch: deps.fetch }),
    });
    if (lookup.state !== 'complete') return wait(row, now);
    if (lookup.messages.length !== 1) {
      return advance('failed', {
        error: `burn tx'inde ${lookup.messages.length} CCTP mesajı var; transfer başına tek mesaj bekleniyor`,
      });
    }
    const [attested] = lookup.messages;
    let message: CctpMessage;
    try {
      message = decodeCctpMessage(attested!.message);
    } catch (error) {
      return advance('failed', { error: `mesaj çözülemedi: ${describe(error)}` });
    }
    const reason = rejection(row, message);
    if (reason) return advance('failed', { error: reason });
    return advance('attested', {
      nonce: Buffer.from(message.nonce).toString('hex'),
      message: Buffer.from(attested!.message).toString('hex'),
      attestation: Buffer.from(attested!.attestation).toString('hex'),
      amount: message.burn.amount,
      feeExecuted: message.burn.feeExecuted,
      attestedAt: new Date(now),
    });
  }

  async function attested(row: TransferRow, now: number): Promise<TransferPatch> {
    const message = decodeCctpMessage(hexToBytes(row.message!));
    if (await isCctpNonceUsed(connection, env.programs, message.nonce)) {
      return advance('received', {
        receiveSignature: await oldestSignature(cctpUsedNonceAddress(env.programs, message.nonce)),
      });
    }
    const relayAt = row.attestedAt!.getTime() + deps.relayAfterSeconds * MS_PER_SECOND;
    // Teslim eden sınırlanmışsa (kurum) relayer teslim edemez; kurumun tx'i beklenir.
    const restricted = !new PublicKey(message.destinationCaller).equals(PublicKey.default);
    if (now < relayAt || restricted) {
      const poll = now + deps.backoff.baseSeconds * MS_PER_SECOND;
      return { nextAttemptAt: new Date(restricted ? poll : Math.min(relayAt, poll)), error: null };
    }
    const signature = await deliver(row, message);
    return advance('received', { receiveSignature: signature });
  }

  async function received(row: TransferRow, now: number): Promise<TransferPatch> {
    const job = new PublicKey(row.job);
    const account = await env.client.escrow.fetch('job', job);
    if (account && 'open' in account.status) return wait(row, now);
    const signature = await fundSignature(job);
    if (signature) return advance('funded', { fundSignature: signature });
    if (!account || 'cancelled' in account.status) {
      return advance('failed', { error: 'job fonlanmadan kapandı; mint edilen USDC kurumun hesabında' });
    }
    return advance('funded', {
      fundSignature: null,
      error: `job fonlanmış ama fonlama tx'i son ${SIGNATURE_WINDOW} imzada bulunamadı`,
    });
  }

  async function step(row: TransferRow, now: number): Promise<TransferPatch> {
    switch (row.status) {
      case 'pendingAttestation':
        return awaitingAttestation(row, now);
      case 'attested':
        return attested(row, now);
      case 'received':
        return received(row, now);
      default:
        throw new Error(`relayer ${row.status} durumundaki transferi ilerletmez`);
    }
  }

  return {
    async runOnce() {
      const rows = await store.due(new Date(clock()), deps.batchSize);
      let transitions = 0;
      let errors = 0;
      for (const row of rows) {
        const now = clock();
        let patch: TransferPatch;
        try {
          patch = await step(row, now);
        } catch (error) {
          errors += 1;
          deps.onError?.(error, row);
          patch = wait(row, now, describe(error));
        }
        const updated = await store.update(row.id, patch);
        if (patch.status !== undefined && patch.status !== row.status) {
          transitions += 1;
          deps.onTransition?.(row.status, patch.status, updated);
        }
      }
      return { evaluated: rows.length, transitions, errors };
    },
  };
}
