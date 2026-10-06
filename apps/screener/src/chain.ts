// Zincir: registry `record_screening` tx'inin üretimi, imzası, gönderimi ve onayı. Talimat SDK'nın registry
// builder'ıyla (IDL'den) kurulur: imzacılar `payer` ve `screener_authority` (ikisi de screener authority
// anahtarı), `config` ve `screening_record` PDA'ları Anchor'ın çözücüsüyle türetilir. Compute unit sınırı
// BC-28 profilindendir (`recordScreening`). Tx gönderilmeden önce RPC'de simüle edilir (preflight): programın
// reddettiği tx (ör. authority değişmiş, `Unauthorized`) gönderilmez, hata program hatasıyla döner. Onay
// `confirmed` commitment'la beklenir; blockhash'in son geçerli blok yüksekliği aşılırsa tx düşmüş sayılır.
// Onaydan sonra kayıt zincirden okunur: `screened_at` ve `expires_at` programın saatindendir. RPC uçları
// arasında failover `@squaresdk/solana-hardening`'dendir.
import {
  SQUARE_IDLS,
  TX_COMPUTE_UNIT_LIMITS,
  createSquareClient,
  type SquareClient,
  type SquareProgramIds,
} from '@squaresdk/solana-sdk';
import { createFailoverFetch } from '@squaresdk/solana-hardening';
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import { Connection, type Keypair, type PublicKey, type VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { ScreeningStatus } from './evidence.js';

const COMMITMENT = 'confirmed';

export interface RegistryConfigState {
  readonly screenerAuthority: PublicKey;
  readonly screeningTtlSecs: number;
}

export interface ScreeningRecordState {
  readonly wallet: PublicKey;
  readonly status: ScreeningStatus;
  readonly sourceHash: Uint8Array;
  readonly screenedAt: number;
  readonly expiresAt: number;
}

export interface RecordedScreening {
  readonly signature: string;
  readonly slot: number;
  /** Zincirden okunan kayıt. */
  readonly record: ScreeningRecordState;
}

/** Tx gönderilemedi, zincirde başarısız oldu, düştü ya da onaylandıktan sonra kayıt okunamadı. */
export class ScreeningTxError extends Error {
  constructor(
    message: string,
    /** Tx ağa ulaştıysa imzası; preflight'ta ya da gönderimde reddedildiyse null. */
    readonly signature: string | null,
    readonly programError: ProgramErrorRef | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ScreeningTxError';
  }
}

export interface ScreeningChain {
  readonly connection: Connection;
  readonly client: SquareClient;
  /** Screener authority'nin açık anahtarı (payer ve imzacı). */
  readonly authority: PublicKey;
  /** `RegistryConfig`; registry başlatılmamışsa null. */
  registryConfig(): Promise<RegistryConfigState | null>;
  screeningRecord(wallet: PublicKey, minContextSlot?: number): Promise<ScreeningRecordState | null>;
  recordScreening(params: {
    wallet: PublicKey;
    status: ScreeningStatus;
    sourceHash: Uint8Array;
  }): Promise<RecordedScreening>;
  /** Authority'nin bakiyesi (lamport). */
  balance(): Promise<number>;
  slot(): Promise<number>;
  /** Tercih edilen RPC ucu (log için). */
  endpoint(): string;
}

/** Anchor'ın enum kodlaması. */
const statusArg = (status: ScreeningStatus) => (status === 'clear' ? { clear: {} } : { flagged: {} });

/**
 * İmzalı `record_screening` tx'i: compute budget talimatları ve registry talimatı. Blockhash RPC'den okunur;
 * tx gönderilmez.
 */
export async function buildRecordScreeningTx(params: {
  client: SquareClient;
  authority: Keypair;
  wallet: PublicKey;
  status: ScreeningStatus;
  sourceHash: Uint8Array;
  computeUnitPrice: bigint;
}): Promise<{ transaction: VersionedTransaction; signature: string; lastValidBlockHeight: number }> {
  const { client, authority } = params;
  if (params.sourceHash.length !== 32) throw new Error(`source_hash 32 bayt olmalı, ${params.sourceHash.length} bayt`);
  const ix = await client.registry.instructions.recordScreening(
    [params.wallet, statusArg(params.status), Array.from(params.sourceHash)],
    { payer: authority.publicKey, screenerAuthority: authority.publicKey },
  );
  const built = await client.buildTx([ix], {
    feePayer: authority.publicKey,
    computeUnitLimit: TX_COMPUTE_UNIT_LIMITS.recordScreening,
    computeUnitPrice: params.computeUnitPrice,
  });
  built.transaction.sign([authority]);
  return {
    transaction: built.transaction,
    signature: bs58.encode(built.transaction.signatures[0]!),
    lastValidBlockHeight: built.lastValidBlockHeight,
  };
}

/** Sözleşmedeki (IDL JSON) hata adı; Anchor'ın camelCase IDL'indeki ad değil (API ile aynı). */
function contractError(ref: ProgramErrorRef | null): ProgramErrorRef | null {
  if (!ref) return null;
  const errors = SQUARE_IDLS[ref.program].errors as readonly { code: number; name: string }[];
  return { ...ref, name: errors.find((error) => error.code === ref.code)?.name ?? ref.name };
}

/** `InstructionError: [i, { Custom: kod }]` → registry hata adı (registry'nin tek talimatı bu tx'tedir). */
export function registryErrorOf(err: unknown): ProgramErrorRef | null {
  const instruction = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const code = (instruction?.[1] as { Custom?: unknown } | undefined)?.Custom;
  if (typeof code !== 'number') return null;
  const errors = SQUARE_IDLS.registry.errors as readonly { code: number; name: string }[];
  const found = errors.find((error) => error.code === code);
  return found ? { program: 'registry', code, name: found.name } : null;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createChain(params: {
  urls: readonly string[];
  timeoutMs: number;
  cooldownMs: number;
  programIds: SquareProgramIds;
  authority: Keypair;
  computeUnitPrice: bigint;
  confirmPollMs: number;
  onFailover?: (event: { from: string; reason: string; status?: number }) => void;
  sleep?: (ms: number) => Promise<void>;
}): ScreeningChain {
  const fetch = createFailoverFetch({
    endpoints: params.urls,
    timeoutMs: params.timeoutMs,
    cooldownMs: params.cooldownMs,
    ...(params.onFailover ? { onFailover: params.onFailover } : {}),
  });
  const connection = new Connection(params.urls[0]!, { commitment: COMMITMENT, fetch });
  const client = createSquareClient({ connection, programIds: params.programIds, commitment: COMMITMENT });
  const coder = client.registry.program.coder.accounts;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { authority } = params;

  /** Sahibi registry olan hesabın verisi; yoksa null. */
  async function registryAccount(address: PublicKey, minContextSlot?: number): Promise<Buffer | null> {
    const { value } = await connection.getAccountInfoAndContext(address, {
      commitment: COMMITMENT,
      ...(minContextSlot === undefined ? {} : { minContextSlot }),
    });
    if (!value) return null;
    if (!value.owner.equals(params.programIds.registry)) {
      throw new Error(`${address.toBase58()} registry programına ait değil`);
    }
    return value.data;
  }

  async function screeningRecord(wallet: PublicKey, minContextSlot?: number): Promise<ScreeningRecordState | null> {
    const data = await registryAccount(client.pda.screeningRecord(wallet)[0], minContextSlot);
    if (!data) return null;
    const record = coder.decode('screeningRecord', data) as {
      wallet: PublicKey;
      status: { clear?: object; flagged?: object };
      sourceHash: number[];
      screenedAt: { toNumber(): number };
      expiresAt: { toNumber(): number };
    };
    return {
      wallet: record.wallet,
      status: record.status.clear ? 'clear' : 'flagged',
      sourceHash: Uint8Array.from(record.sourceHash),
      screenedAt: record.screenedAt.toNumber(),
      expiresAt: record.expiresAt.toNumber(),
    };
  }

  /** Onaylandığı slot; zincirde başarısız ya da süresi dolmuşsa hata. */
  async function confirm(signature: string, lastValidBlockHeight: number): Promise<number> {
    for (;;) {
      const status = (await connection.getSignatureStatuses([signature])).value[0];
      if (status?.err) {
        const programError = registryErrorOf(status.err);
        throw new ScreeningTxError(
          programError ? `tx zincirde başarısız: ${programError.name}` : 'tx zincirde başarısız',
          signature,
          programError,
        );
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return status.slot;
      if ((await connection.getBlockHeight(COMMITMENT)) > lastValidBlockHeight) {
        throw new ScreeningTxError('tx onaylanmadan blockhash süresi doldu', signature, null);
      }
      await sleep(params.confirmPollMs);
    }
  }

  return {
    connection,
    client,
    authority: authority.publicKey,
    async registryConfig() {
      const data = await registryAccount(client.pda.registryConfig()[0]);
      if (!data) return null;
      const config = coder.decode('registryConfig', data) as {
        screenerAuthority: PublicKey;
        screeningTtlSecs: { toNumber(): number };
      };
      return { screenerAuthority: config.screenerAuthority, screeningTtlSecs: config.screeningTtlSecs.toNumber() };
    },
    screeningRecord,
    async recordScreening({ wallet, status, sourceHash }) {
      const { transaction, signature, lastValidBlockHeight } = await buildRecordScreeningTx({
        client,
        authority,
        wallet,
        status,
        sourceHash,
        computeUnitPrice: params.computeUnitPrice,
      });
      try {
        await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          preflightCommitment: COMMITMENT,
        });
      } catch (error) {
        let programError: ProgramErrorRef | null = null;
        try {
          programError = contractError(client.mapError(error));
        } catch {
          // Logdaki kod IDL'de yok: hata program hatası olmadan döner.
        }
        throw new ScreeningTxError(
          programError
            ? `tx reddedildi: ${programError.program} ${programError.name}`
            : `tx gönderilemedi: ${describe(error)}`,
          null,
          programError,
          { cause: error },
        );
      }
      const slot = await confirm(signature, lastValidBlockHeight);
      let record: ScreeningRecordState | null;
      try {
        record = await screeningRecord(wallet, slot);
      } catch (error) {
        throw new ScreeningTxError(`tx onaylandı, kayıt okunamadı: ${describe(error)}`, signature, null, {
          cause: error,
        });
      }
      if (!record) throw new ScreeningTxError('tx onaylandı, kayıt zincirde yok', signature, null);
      return { signature, slot, record };
    },
    balance: () => connection.getBalance(authority.publicKey, COMMITMENT),
    slot: () => connection.getSlot(COMMITMENT),
    endpoint: () => fetch.endpoint(),
  };
}
