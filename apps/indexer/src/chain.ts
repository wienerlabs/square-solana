// Zincir okuması: yalnızca kesinleşmiş (`finalized`) veri; böylece fork geri alımı gerekmez (veri modeli §1).
// RPC uçları arasında failover `@squaresdk/solana-hardening`'dendir. Hesap okumalarında `minContextSlot`
// verilir: okunan durum, onu tetikleyen tx'ten eski olamaz.
import { createFailoverFetch } from '@squaresdk/solana-hardening';
import {
  Connection,
  PublicKey,
  type AccountInfo,
  type ConfirmedSignatureInfo,
  type SignatureStatus,
} from '@solana/web3.js';
import bs58 from 'bs58';

const COMMITMENT = 'finalized';
/** `getMultipleAccounts` ve `getSignatureStatuses` RPC sınırları. */
const ACCOUNTS_PER_CALL = 100;
const STATUSES_PER_CALL = 256;

export interface FinalizedTransaction {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  /** Tx başarısızsa hata; başarısız tx durumu değiştirmez. */
  readonly failed: boolean;
  readonly logs: readonly string[];
  /** Yazılabilir hesaplar (lookup table'dan yüklenenler dahil). */
  readonly writableAccounts: readonly PublicKey[];
}

export interface AccountSnapshot {
  /** Durumun okunduğu slot. */
  readonly slot: number;
  readonly accounts: readonly (AccountInfo<Buffer> | null)[];
}

export interface ProgramAccountsSnapshot {
  readonly slot: number;
  readonly accounts: readonly { pubkey: PublicKey; account: AccountInfo<Buffer> }[];
}

export interface Chain {
  /** web3.js bağlantısı (SDK client'ı bununla kurulur). */
  readonly connection: Connection;
  finalizedSlot(): Promise<number>;
  /** Programın imzaları, yeniden eskiye; `until` hariç ondan yenileri. */
  signatures(
    program: PublicKey,
    options: { until?: string; before?: string; limit: number },
  ): Promise<ConfirmedSignatureInfo[]>;
  /** Kesinleşmemiş ya da bilinmeyen imzada null. */
  transaction(signature: string): Promise<FinalizedTransaction | null>;
  accounts(addresses: readonly PublicKey[], minContextSlot: number): Promise<AccountSnapshot>;
  programAccounts(program: PublicKey, discriminator: Uint8Array): Promise<ProgramAccountsSnapshot>;
  signatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]>;
  /** Tercih edilen RPC ucu (health ve log için). */
  endpoint(): string;
}

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export function createChain(params: {
  urls: readonly string[];
  timeoutMs: number;
  cooldownMs: number;
  onFailover?: (event: { from: string; reason: string; status?: number }) => void;
}): Chain {
  const fetch = createFailoverFetch({
    endpoints: params.urls,
    timeoutMs: params.timeoutMs,
    cooldownMs: params.cooldownMs,
    ...(params.onFailover ? { onFailover: params.onFailover } : {}),
  });
  // web3.js 429'u kendisi bekleyerek yeniden dener; failover ucu değiştirir.
  const connection = new Connection(params.urls[0]!, { commitment: COMMITMENT, fetch });

  return {
    connection,
    finalizedSlot: () => connection.getSlot(COMMITMENT),
    signatures: (program, options) =>
      connection.getSignaturesForAddress(
        program,
        {
          limit: options.limit,
          ...(options.until ? { until: options.until } : {}),
          ...(options.before ? { before: options.before } : {}),
        },
        COMMITMENT,
      ),
    async transaction(signature) {
      const tx = await connection.getTransaction(signature, {
        commitment: COMMITMENT,
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return null;
      if (!tx.meta) throw new Error(`tx meta verisi yok: ${signature}`);
      const message = tx.transaction.message;
      const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? null });
      const writableAccounts = Array.from({ length: keys.length }, (_, index) => index)
        .filter((index) => message.isAccountWritable(index))
        .map((index) => keys.get(index)!);
      return {
        signature,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        failed: tx.meta.err !== null,
        logs: tx.meta.logMessages ?? [],
        writableAccounts,
      };
    },
    async accounts(addresses, minContextSlot) {
      // Parçalar ayrı çağrılardır; her biri en az `minContextSlot`'taki durumu verir. En küçük bağlam slot'u
      // bütün parçalar için doğru olan alt sınırdır.
      let slot = Number.POSITIVE_INFINITY;
      const accounts: (AccountInfo<Buffer> | null)[] = [];
      for (const part of chunks(addresses, ACCOUNTS_PER_CALL)) {
        const result = await connection.getMultipleAccountsInfoAndContext([...part], {
          commitment: COMMITMENT,
          minContextSlot,
        });
        slot = Math.min(slot, result.context.slot);
        accounts.push(...result.value);
      }
      return { slot: Number.isFinite(slot) ? slot : minContextSlot, accounts };
    },
    async programAccounts(program, discriminator) {
      const result = await connection.getProgramAccounts(program, {
        commitment: COMMITMENT,
        withContext: true,
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(discriminator) } }],
      });
      return { slot: result.context.slot, accounts: result.value };
    },
    async signatureStatuses(signatures) {
      const statuses: (SignatureStatus | null)[] = [];
      for (const part of chunks(signatures, STATUSES_PER_CALL)) {
        statuses.push(...(await connection.getSignatureStatuses([...part])).value);
      }
      return statuses;
    },
    endpoint: () => fetch.endpoint(),
  };
}
