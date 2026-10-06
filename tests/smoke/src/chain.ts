// Zincirle konuşan yardımcılar: imzalı gönderim ve tx kaydı (imza, CU, ücret, boyut), Clock sysvar'ından
// zincirin saati, BPF upgradeable loader hesaplarının çözümü ve executable hash'i (solana-verify yöntemi).
import { sha256 } from '@noble/hashes/sha2';
import {
  ComputeBudgetProgram,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type Keypair,
  type VersionedMessage,
  type VersionedTransaction,
} from '@solana/web3.js';
import type { BuiltTx, SquareClient } from '@squaresdk/solana-sdk';
import type { ProgramErrorRef } from '@squaresdk/solana-types';

/** Raporun bir satırı: gönderilmiş ve onaylanmış bir tx. */
export interface TxRecord {
  /** Akıştaki adım (ör. "1", "6 + 8", "ret · 7"). */
  step: string;
  /** Tx'in içeriği (ör. "`createJob` + `fundJob`"). */
  label: string;
  signature: string;
  slot: number;
  computeUnits: number;
  /** Tx'in `SetComputeUnitLimit`'i; yoksa null (varsayılan sınır). */
  computeUnitLimit: number | null;
  feeLamports: number;
  /** İmzalı tx'in tel boyutu (bayt). */
  sizeBytes: number;
  /** Zincirde başarısız olan tx'in hatası (beklenen ret); başarılıysa null. */
  error: ProgramErrorRef | null;
}

/** `getTransaction` yanıtının raporun kullandığı kısmı. */
export interface ConfirmedTxMeta {
  slot: number;
  meta: {
    fee: number;
    computeUnitsConsumed?: number;
    err: unknown;
    logMessages?: string[] | null;
  } | null;
}

/** Mesajdaki `SetComputeUnitLimit` (ComputeBudget talimatı 2, u32 LE); yoksa null. */
export function computeUnitLimitOf(message: VersionedMessage): number | null {
  const keys = message.staticAccountKeys;
  const ix = message.compiledInstructions.find(
    (i) => keys[i.programIdIndex]!.equals(ComputeBudgetProgram.programId) && i.data[0] === 2,
  );
  return ix ? Buffer.from(ix.data).readUInt32LE(1) : null;
}

/** Onaylanmış tx'in kaydı. Zincirdeki hata program hatasına eşlenemezse fırlatır. */
export function txRecordOf(params: {
  step: string;
  label: string;
  signature: string;
  transaction: VersionedTransaction;
  confirmed: ConfirmedTxMeta;
  mapError: SquareClient['mapError'];
}): TxRecord {
  const { meta } = params.confirmed;
  if (!meta) throw new Error(`tx'in meta verisi yok: ${params.signature}`);
  if (meta.computeUnitsConsumed === undefined)
    throw new Error(`RPC computeUnitsConsumed döndürmedi: ${params.signature}`);
  let error: ProgramErrorRef | null = null;
  if (meta.err) {
    error = params.mapError({ logs: meta.logMessages ?? [] });
    if (!error) throw new Error(`tx başarısız, program hatası değil: ${params.signature} ${JSON.stringify(meta.err)}`);
  }
  return {
    step: params.step,
    label: params.label,
    signature: params.signature,
    slot: params.confirmed.slot,
    computeUnits: meta.computeUnitsConsumed,
    computeUnitLimit: computeUnitLimitOf(params.transaction.message),
    feeLamports: meta.fee,
    sizeBytes: params.transaction.serialize().length,
    error,
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Tx'i (yeniden) kuran fonksiyon: süresi dolan blockhash'le düşen tx taze blockhash'le yeniden kurulur. */
export type TxBuilder = () => Promise<BuiltTx>;

/** Blockhash'i dolup zincire girmeden düşen tx'in en fazla kaç kez kurulup gönderileceği. */
export const MAX_SEND_ATTEMPTS = 3;

export interface Sender {
  /**
   * Tx'i kurar, imzalar, gönderir, onaylanmasını bekler ve kaydını döner. Tx zincire girmeden blockhash'i
   * dolarsa yeniden kurulup gönderilir. `expectError` verilirse tx ön simülasyonsuz gönderilir ve zincirde
   * tam bu program hatasıyla düşmesi beklenir.
   */
  send(
    step: string,
    label: string,
    build: TxBuilder,
    signers: readonly Keypair[],
    expectError?: string,
  ): Promise<TxRecord>;
  readonly records: readonly TxRecord[];
}

const isExpired = (error: unknown) => error instanceof TransactionExpiredBlockheightExceededError;

/** Zincire girip düşen tx'in hatası (`TransactionError`: dize ya da `{ InstructionError: … }`); `Error` değildir. */
export const isLandedTransactionError = (error: unknown): boolean =>
  !(error instanceof Error) && (typeof error === 'string' || (typeof error === 'object' && error !== null));

export function createSender(connection: Connection, client: SquareClient, log: (line: string) => void): Sender {
  const records: TxRecord[] = [];
  const commitment = 'confirmed' as const;

  async function submit(label: string, built: BuiltTx, signers: readonly Keypair[], skipPreflight: boolean) {
    const byKey = new Map(signers.map((k) => [k.publicKey.toBase58(), k]));
    const needed = built.signers.map((key) => {
      const signer = byKey.get(key.toBase58());
      if (!signer) throw new Error(`${label}: ${key.toBase58()} için imzacı verilmedi`);
      return signer;
    });
    built.transaction.sign(needed);
    let signature: string;
    try {
      signature = await connection.sendRawTransaction(built.transaction.serialize(), { skipPreflight });
    } catch (error) {
      const mapped = client.mapError(error);
      throw new Error(`${label}: gönderim reddedildi${mapped ? ` (${mapped.program}: ${mapped.name})` : ''}`, {
        cause: error,
      });
    }
    try {
      await connection.confirmTransaction(
        { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
        commitment,
      );
    } catch (error) {
      // web3.js, imza durumunu yoklayarak gördüğü zincir hatasını ham `TransactionError` olarak fırlatır (abonelik
      // bildiriminde değer olarak döner). Tx zincire girmiştir; kaydı ve hatası `getTransaction`'dan okunur.
      if (!isLandedTransactionError(error)) throw error;
    }
    return signature;
  }

  return {
    records,
    async send(step, label, build, signers, expectError) {
      let built = await build();
      let signature: string | null = null;
      for (let attempt = 1; signature === null; attempt += 1) {
        try {
          signature = await submit(label, built, signers, expectError !== undefined);
        } catch (error) {
          if (!isExpired(error) || attempt >= MAX_SEND_ATTEMPTS) throw error;
          log(`  ${label}: tx zincire girmeden blockhash'i doldu, yeniden kuruluyor (${attempt}/${MAX_SEND_ATTEMPTS})`);
          built = await build();
        }
      }
      let confirmed: ConfirmedTxMeta | null = null;
      for (let attempt = 0; attempt < 30 && !confirmed; attempt += 1) {
        confirmed = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 });
        if (!confirmed) await sleep(500);
      }
      if (!confirmed) throw new Error(`${label}: onaylanan tx okunamadı: ${signature}`);
      const record = txRecordOf({
        step,
        label,
        signature,
        transaction: built.transaction,
        confirmed,
        mapError: client.mapError,
      });
      if (expectError === undefined && record.error) {
        throw new Error(`${label}: ${record.error.program} ${record.error.name} (${signature})`);
      }
      if (expectError !== undefined && record.error?.name !== expectError) {
        throw new Error(
          `${label}: ${expectError} bekleniyordu, ${record.error ? record.error.name : 'tx başarılı'} (${signature})`,
        );
      }
      records.push(record);
      log(`  ${step.padEnd(8)} ${label}: ${signature} · ${record.computeUnits} CU · ${record.feeLamports} lamport`);
      return record;
    },
  };
}

/** Clock sysvar'ının `unix_timestamp`'i (32. bayttan i64 LE): programların gördüğü saat. */
export function clockUnixTimestamp(data: Uint8Array): number {
  if (data.length < 40) throw new Error(`Clock sysvar'ı 40 bayttan kısa: ${data.length}`);
  return Number(Buffer.from(data).readBigInt64LE(32));
}

export async function chainTime(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!info) throw new Error('Clock sysvar okunamadı');
  return clockUnixTimestamp(info.data);
}

/** Zincirin saati `target`'a ulaşana kadar bekler (programların `now`'ı). */
export async function waitForChainTime(connection: Connection, target: number, pollMs = 1_000): Promise<number> {
  for (;;) {
    const now = await chainTime(connection);
    if (now >= target) return now;
    await sleep(Math.min(pollMs, Math.max(200, (target - now) * 1_000)));
  }
}

/**
 * Kesinleşmiş slot `slot`'u geçene kadar bekler. ALT'a eklenen adresler sonraki slottan itibaren
 * kullanılabilir; ancak işlem zamanlayıcısı ALT'ı kök bankadan çözer, kök onu görmeden gönderilen v0 tx
 * simülasyondan geçip zincire girmeden düşer (yeni açılmış validator'da kök ~32 slot geride kalır).
 */
export async function waitForFinalizedSlotAfter(connection: Connection, slot: number): Promise<void> {
  while ((await connection.getSlot('finalized')) <= slot) await sleep(400);
}

/** BPF upgradeable loader'ın `ProgramData` başlığı: etiket (4) + slot (8) + Option<authority> (1 + 32). */
export const PROGRAM_DATA_METADATA_BYTES = 45;
export const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** `Program` hesabından `ProgramData` adresi (etiket 2). */
export function programDataAddress(data: Uint8Array): PublicKey {
  const buffer = Buffer.from(data);
  if (buffer.length < 36 || buffer.readUInt32LE(0) !== 2) throw new Error('upgradeable loader Program hesabı değil');
  return new PublicKey(buffer.subarray(4, 36));
}

export interface ProgramDataInfo {
  slot: number;
  /** null: program değiştirilemez (upgrade authority yok). */
  upgradeAuthority: PublicKey | null;
  executable: Uint8Array;
}

/** `ProgramData` hesabı (etiket 3). */
export function parseProgramData(data: Uint8Array): ProgramDataInfo {
  const buffer = Buffer.from(data);
  if (buffer.length < PROGRAM_DATA_METADATA_BYTES || buffer.readUInt32LE(0) !== 3) {
    throw new Error('upgradeable loader ProgramData hesabı değil');
  }
  return {
    slot: Number(buffer.readBigUInt64LE(4)),
    upgradeAuthority: buffer[12] === 1 ? new PublicKey(buffer.subarray(13, 45)) : null,
    executable: Uint8Array.from(buffer.subarray(PROGRAM_DATA_METADATA_BYTES)),
  };
}

/**
 * Executable hash'i, `solana-verify get-executable-hash` / `get-program-hash` yöntemiyle: sondaki sıfır
 * baytlar atılır, kalanın SHA-256'sı (hex). Zincirdeki ProgramData ve yerel `.so` aynı hash'i verir.
 */
export function executableHash(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return Buffer.from(sha256(bytes.subarray(0, end))).toString('hex');
}

/** Squads v4 programı ve vault PDA'sı: `["multisig", multisig, "vault", [index]]` (`square_common::squads`). */
export const SQUADS_V4_PROGRAM_ID = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');

export function squadsVault(multisig: PublicKey, vaultIndex: number): PublicKey {
  const enc = new TextEncoder();
  return PublicKey.findProgramAddressSync(
    [enc.encode('multisig'), multisig.toBytes(), enc.encode('vault'), Uint8Array.of(vaultIndex)],
    SQUADS_V4_PROGRAM_ID,
  )[0];
}
