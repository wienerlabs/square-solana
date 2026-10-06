// Test fixture: relayer'ın ve tx hazırlığının okuduğu RPC yöntemlerini bellekteki hesaplarla yanıtlayan bağlantı.
// Gönderilen tx kaydedilir; simülasyon sonucu, imza geçmişi ve tx logları test tarafından verilir.
import {
  AddressLookupTableAccount,
  PublicKey,
  type AccountInfo,
  type Connection,
  type VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

export interface SignatureEntry {
  signature: string;
  err: unknown;
}

export class TestChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly tables = new Map<string, AddressLookupTableAccount>();
  /** Adresin imzaları, yeniden eskiye (RPC'nin sırası). */
  readonly signatures = new Map<string, SignatureEntry[]>();
  /** İmzanın tx logları. */
  readonly logs = new Map<string, string[]>();
  readonly sent: VersionedTransaction[] = [];
  simulation: { err: unknown; logs: string[] } = { err: null, logs: [] };
  /** Gönderilen tx'in zincirdeki sonucu (onay durumu). */
  sendResult: unknown = null;
  /** Gönderimde çalışır (ör. nonce hesabını açmak için). */
  onSend: ((tx: VersionedTransaction, signature: string) => void) | null = null;
  readonly blockhash = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toBase58();
  readonly lastValidBlockHeight = 4242;
  blockHeight = 100;

  setAccount(address: PublicKey, owner: PublicKey, data: Buffer = Buffer.alloc(0)): void {
    this.accounts.set(address.toBase58(), { data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0 });
  }

  deleteAccount(address: PublicKey): void {
    this.accounts.delete(address.toBase58());
  }

  setLookupTable(key: PublicKey, addresses: PublicKey[]): void {
    this.tables.set(
      key.toBase58(),
      new AddressLookupTableAccount({
        key,
        state: {
          deactivationSlot: BigInt('18446744073709551615'),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses,
        },
      }),
    );
  }

  lookupTable(key: PublicKey): AddressLookupTableAccount {
    const table = this.tables.get(key.toBase58());
    if (!table) throw new Error(`tablo yok: ${key.toBase58()}`);
    return table;
  }

  /** Adrese yeni (en yeni) imza ekler. */
  addSignature(address: PublicKey, signature: string, logs: string[] = [], err: unknown = null): void {
    this.signatures.set(address.toBase58(), [{ signature, err }, ...(this.signatures.get(address.toBase58()) ?? [])]);
    this.logs.set(signature, logs);
  }

  connection(): Connection {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- yöntemler aynı durumu paylaşır.
    const chain = this;
    return {
      commitment: 'confirmed',
      rpcEndpoint: 'test-chain',
      async getLatestBlockhash() {
        return { blockhash: chain.blockhash, lastValidBlockHeight: chain.lastValidBlockHeight };
      },
      async getAccountInfo(address: PublicKey) {
        return chain.accounts.get(address.toBase58()) ?? null;
      },
      async getAccountInfoAndContext(address: PublicKey) {
        return { context: { slot: 1 }, value: chain.accounts.get(address.toBase58()) ?? null };
      },
      async getAddressLookupTable(key: PublicKey) {
        return { context: { slot: 1 }, value: chain.tables.get(key.toBase58()) ?? null };
      },
      async getSignaturesForAddress(address: PublicKey, options?: { limit?: number }) {
        return (chain.signatures.get(address.toBase58()) ?? []).slice(0, options?.limit ?? 1000);
      },
      async getTransaction(signature: string) {
        const logs = chain.logs.get(signature);
        return logs === undefined ? null : { meta: { logMessages: logs, err: null } };
      },
      async simulateTransaction() {
        return { context: { slot: 1 }, value: { ...chain.simulation, unitsConsumed: 190_000 } };
      },
      async sendRawTransaction(raw: Uint8Array) {
        const { VersionedTransaction } = await import('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(raw);
        const signature = bs58.encode(tx.signatures[0]!);
        chain.sent.push(tx);
        chain.onSend?.(tx, signature);
        return signature;
      },
      async getSignatureStatuses() {
        return { context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: chain.sendResult }] };
      },
      async getBlockHeight() {
        return chain.blockHeight;
      },
    } as unknown as Connection;
  }
}
