// Test fixture: SDK’nın okuduğu RPC yöntemlerini bellekteki hesaplarla yanıtlayan bağlantı (packages/sdk testlerinin
// yardımcısıyla aynı; CLI’nin de okuduğu genesis hash, blok saati ve gönderim yöntemleri eklendi).
import { AddressLookupTableAccount, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';

/** Devnet'in genesis hash'i; CAIP-2 zincir referansı ilk 32 karakteridir. */
export const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export class TestChain {
  private readonly accounts = new Map<string, AccountInfo<Buffer>>();
  private readonly tables = new Map<string, AddressLookupTableAccount>();
  readonly blockhash = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toBase58();
  readonly lastValidBlockHeight = 4242;

  setAccount(address: PublicKey, owner: PublicKey, data: Buffer): void {
    this.accounts.set(address.toBase58(), { data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0 });
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

  /** Kayıtlı tablo (tx'in adres anahtarlarını çözmek için). */
  lookupTable(key: PublicKey): AddressLookupTableAccount {
    const table = this.tables.get(key.toBase58());
    if (!table) throw new Error(`tablo yok: ${key.toBase58()}`);
    return table;
  }

  connection(): Connection {
    const { accounts, tables, blockhash, lastValidBlockHeight } = this;
    return {
      commitment: 'confirmed',
      rpcEndpoint: 'test-chain',
      async getLatestBlockhash() {
        return { blockhash, lastValidBlockHeight };
      },
      async getAccountInfo(address: PublicKey) {
        return accounts.get(address.toBase58()) ?? null;
      },
      async getAccountInfoAndContext(address: PublicKey) {
        return { context: { slot: 1 }, value: accounts.get(address.toBase58()) ?? null };
      },
      async getAddressLookupTable(key: PublicKey) {
        return { context: { slot: 1 }, value: tables.get(key.toBase58()) ?? null };
      },
      async getGenesisHash() {
        return GENESIS_HASH;
      },
    } as unknown as Connection;
  }
}
