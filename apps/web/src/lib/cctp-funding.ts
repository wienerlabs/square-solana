// CCTP ile fonlamanın arayüz kuralları (FE-19, docs/design/cctp-funding.md). Kaynak zincirde yakılan USDC'nin
// tutarı, transferin aşamaları ve Square API'nin kurduğu fonlama tx'inin imzadan önceki denetimi. Burn'ü kaynak
// cüzdan imzalar; kaydı ve kurumun tx'ini API yapar (BE-26), tx'i kurumun Solana cüzdanı imzalar.
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  type AddressLookupTableAccount,
  type PublicKey,
  type VersionedTransaction,
} from '@solana/web3.js';
import { cctpMaxFee, RECEIVE_MESSAGE_DISCRIMINATOR, SQUARE_IDLS } from '@squaresdk/solana-sdk';
import type { CctpTransfer, CctpTransferStatus } from '@squaresdk/solana-types';
import { SquareApiError } from './square-api';

/** Süren bir transferin yeniden okunma aralığı: hızlı kesinlikte attestation yaklaşık bir dakika sürer. */
export const CCTP_POLL_MS = 5_000;
/** Kaynak zincirdeki tx'in makbuzuna bakma aralığı. */
export const EVM_RECEIPT_POLL_MS = 3_000;
/** Job başına okunan en fazla transfer. */
export const CCTP_TRANSFER_LIMIT = 20;

/** Kurumun Solana'daki USDC'sinin job'u karşılamayan kısmı; hesap yoksa bakiye sıfırdır. */
export const fundingShortfall = (jobAmount: bigint, balance: bigint | null): bigint => {
  const held = balance ?? 0n;
  return held >= jobAmount ? 0n : jobAmount - held;
};

/** Burn'den mint edilecek en az tutar: attester `maxFee`'den (baz puan, yukarı yuvarlanmış) fazlasını alamaz. */
export const leastMinted = (amount: bigint, feeBps: number): bigint => amount - cctpMaxFee(amount, feeBps);

const BPS = 10_000n;

/**
 * En az `need` mint edecek en küçük burn. `a − ⌈a·f/10⁴⌉ ≥ need`, sağ taraf tam sayı olduğu için
 * `a·(10⁴ − f) ≥ need·10⁴`'e denktir; en küçük `a` bunun tavanıdır. Ücret alınmayan kesinlikte burn ihtiyacın
 * kendisidir. Ücret tutarın tamamını alabiliyorsa (≥ 10⁴ baz puan) hiçbir burn yetmez.
 */
export function burnAmountFor(need: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0) throw new Error(`fee must be a non-negative integer bps: ${feeBps}`);
  if (BigInt(feeBps) >= BPS) throw new Error(`a fee of ${feeBps} bps takes the whole amount`);
  if (need <= 0n) return 0n;
  const keep = BPS - BigInt(feeBps);
  return (need * BPS + keep - 1n) / keep;
}

const ACTIVE: ReadonlySet<CctpTransferStatus> = new Set(['pendingAttestation', 'attested', 'received']);

/** Transfer hâlâ ilerliyor mu (relayer ya da kurum bir adım atacak mı)? */
export const transferActive = (transfer: CctpTransfer): boolean => ACTIVE.has(transfer.status);

/** Mesaj imzalandı, job açık: kurum mint ile fonlamayı (ya da yalnızca fonlamayı) imzalayabilir. */
export const awaitsFunding = (transfer: CctpTransfer, jobOpen: boolean): boolean =>
  jobOpen && (transfer.status === 'attested' || transfer.status === 'received');

/** `stopped`: transfer başarısız oldu, bu adıma hiç gelinmeyecek. */
export type CctpStepState = 'done' | 'current' | 'pending' | 'stopped';

export interface CctpStep {
  key: 'burned' | 'attested' | 'minted' | 'funded';
  state: CctpStepState;
  /** Adımın Solana'daki ya da kaynak zincirdeki imzası. */
  signature: string | null;
}

/** Transferin dört adımı: burn, Circle'ın attestation'ı, Solana'da mint, job'un fonlanması. */
export function transferSteps(transfer: CctpTransfer, jobFunded: boolean): CctpStep[] {
  const attested = transfer.nonce !== null;
  const minted = transfer.receiveSignature !== null;
  const funded = transfer.status === 'funded' || jobFunded;
  const steps: Omit<CctpStep, 'state'>[] = [
    { key: 'burned', signature: transfer.sourceTxHash },
    { key: 'attested', signature: null },
    { key: 'minted', signature: transfer.receiveSignature },
    { key: 'funded', signature: transfer.fundSignature },
  ];
  const reached = [true, attested, minted || funded, funded];
  const next = reached.indexOf(false);
  return steps.map((step, index) => ({
    ...step,
    state: reached[index] ? 'done' : transfer.status === 'failed' ? 'stopped' : index === next ? 'current' : 'pending',
  }));
}

/** Transfer listesinden gösterilecek olan: süren ya da son açılan. Liste API'den yeniden eskiye gelir. */
export function currentTransfer(transfers: readonly CctpTransfer[]): CctpTransfer | null {
  return transfers.find(transferActive) ?? transfers[0] ?? null;
}

export interface FundTxExpectation {
  /** Tx'i ödeyen ve imzalayan tek cüzdan: job'un kurumu. */
  wallet: PublicKey;
  job: PublicKey;
  escrowProgram: PublicKey;
  messageTransmitter: PublicKey;
  step: 'receiveAndFund' | 'fund';
  /** `receiveAndFund`: transferin attestation'lı mesajı ve attestation'ı (API'nin kaydı, Circle'ın imzaladığı). */
  message: Uint8Array | null;
  attestation: Uint8Array | null;
}

// Çalışma anındaki IDL sözleşmenin JSON'udur (adlar snake_case); TS tipi Anchor'ın camelCase görünümüdür.
interface IdlInstruction {
  name: string;
  discriminator: readonly number[];
  accounts: readonly { name: string }[];
}
const FUND_JOB = (SQUARE_IDLS.escrow.instructions as readonly IdlInstruction[]).find((ix) => ix.name === 'fund_job');
if (!FUND_JOB) throw new Error("escrow IDL'inde fund_job yok");
const FUND_JOB_DISCRIMINATOR = Uint8Array.from(FUND_JOB.discriminator);
const FUND_JOB_INSTITUTION = FUND_JOB.accounts.findIndex((account) => account.name === 'institution');
const FUND_JOB_JOB = FUND_JOB.accounts.findIndex((account) => account.name === 'job');

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const startsWith = (data: Uint8Array, prefix: Uint8Array) => equalBytes(data.subarray(0, prefix.length), prefix);

const borshBytes = (bytes: Uint8Array) => {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
};

/** `receive_message`'ın verisi: ayırıcı ve borsh `{ message, attestation }` (SDK'nın `receiveMessageInstruction`'ı). */
export function receiveMessageData(message: Uint8Array, attestation: Uint8Array): Uint8Array {
  const parts = [RECEIVE_MESSAGE_DISCRIMINATOR, borshBytes(message), borshBytes(attestation)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * API'nin kurduğu fonlama tx'i imzalanmadan önce: yalnızca bu cüzdan öder ve imzalar; çağrılan programlar compute
 * bütçesi, escrow ve (mint ile) CCTP'nin `MessageTransmitterV2`'si ve associated token programıdır. Escrow
 * talimatı tek bir `fund_job`'tur, bu job'u bu kurum adına fonlar. Mint varsa tek `receive_message`, transferin
 * mesajı ve attestation'ıyla. Denetim geçerse null, geçmezse sebebi.
 */
export function fundTxProblem(
  tx: VersionedTransaction,
  lookupTables: readonly AddressLookupTableAccount[],
  expected: FundTxExpectation,
): string | null {
  const { message } = tx;
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
  if (signers.length !== 1 || !signers[0]!.equals(expected.wallet)) {
    return 'The funding transaction must be paid and signed by this wallet alone.';
  }
  let keys: ReturnType<typeof message.getAccountKeys>;
  try {
    keys = message.getAccountKeys({ addressLookupTableAccounts: [...lookupTables] });
  } catch {
    return 'The funding transaction uses an address lookup table that could not be read.';
  }
  const receiving = expected.step === 'receiveAndFund';
  const allowed = [ComputeBudgetProgram.programId, expected.escrowProgram];
  if (receiving) allowed.push(expected.messageTransmitter, ASSOCIATED_TOKEN_PROGRAM_ID);

  let funds = 0;
  let receives = 0;
  for (const ix of message.compiledInstructions) {
    const program = keys.get(ix.programIdIndex);
    if (!program || !allowed.some((id) => id.equals(program))) {
      return `The funding transaction calls a program this page does not expect: ${program?.toBase58() ?? 'unknown'}.`;
    }
    if (program.equals(expected.escrowProgram)) {
      funds += 1;
      const institution = keys.get(ix.accountKeyIndexes[FUND_JOB_INSTITUTION] ?? -1);
      const job = keys.get(ix.accountKeyIndexes[FUND_JOB_JOB] ?? -1);
      if (!startsWith(ix.data, FUND_JOB_DISCRIMINATOR)) return 'The escrow instruction is not fund_job.';
      if (!institution?.equals(expected.wallet) || !job?.equals(expected.job)) {
        return 'The funding transaction funds another job or institution.';
      }
    }
    if (program.equals(expected.messageTransmitter)) {
      receives += 1;
      if (!expected.message || !expected.attestation) return 'The transfer has no attested message to deliver.';
      if (!equalBytes(ix.data, receiveMessageData(expected.message, expected.attestation))) {
        return "The funding transaction delivers a message other than this transfer's.";
      }
    }
  }
  if (funds !== 1) return 'The funding transaction must contain exactly one fund_job.';
  if (receiving && receives !== 1) return 'The funding transaction must deliver the attested message once.';
  return null;
}

/** API hatasının açıklaması; diğer hatalar mesajlarıyla. */
export function cctpErrorMessage(error: unknown): string {
  if (error instanceof SquareApiError) {
    switch (error.code) {
      case 'conflict':
        return `The Square API cannot do this now: ${error.apiMessage}`;
      case 'forbidden':
        return 'The Square API answered that this wallet is not the institution of this job or transfer.';
      case 'not_found':
        return `The Square API does not know this job or transfer yet: ${error.apiMessage}`;
      case 'invalid_input':
        return `The Square API refused the request: ${error.apiMessage}`;
      case 'simulation_failed':
      case 'program_error':
        return `The funding transaction would fail on chain: ${error.apiMessage}`;
      case 'rate_limited':
        return 'The Square API is limiting requests from this wallet; try again shortly.';
    }
  }
  return (error as Error).message;
}

const hexOf = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/** Transferin attestation'lı mesajı ve attestation'ı (API'de küçük harf hex, `0x`'siz). */
export function attestedMessage(transfer: CctpTransfer): { message: Uint8Array; attestation: Uint8Array } | null {
  if (transfer.message === null || transfer.attestation === null) return null;
  return { message: hexOf(transfer.message), attestation: hexOf(transfer.attestation) };
}

const pendingBurnKey = (job: string) => `square:cctp-burn:${job}`;
const TX_HASH = /^0x[0-9a-f]{64}$/;

/**
 * Bu tarayıcıdan gönderilip henüz job'a kaydedilmemiş burn'ün hash'i. Yalnızca bir kolaylıktır: tarayıcının deposu
 * kapalı ya da boşsa burn, hash'iyle elle de kaydedilebilir.
 */
export function loadPendingBurn(job: string): `0x${string}` | null {
  try {
    const value = window.localStorage.getItem(pendingBurnKey(job));
    return value && TX_HASH.test(value) ? (value as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export function savePendingBurn(job: string, hash: string | null): void {
  try {
    if (hash) window.localStorage.setItem(pendingBurnKey(job), hash.toLowerCase());
    else window.localStorage.removeItem(pendingBurnKey(job));
  } catch {
    // Depo kapalı: kayıt yalnızca bu sayfanın belleğinde kalır.
  }
}
