// Test fixture (packages/sdk/test/helpers'tan): SDK'nın okuduğu RPC yöntemlerini bellekteki hesaplarla yanıtlayan bağlantı.
// Gerçek RPC gibi her hesap okumasında yanıtın slot'u ilerler.
// Programlar henüz zincirde yok (BC-15…BC-24); hesaplar IDL coder'ıyla kodlanıp buraya konur.
import { AddressLookupTableAccount, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';

export class TestChain {
  private readonly accounts = new Map<string, AccountInfo<Buffer>>();
  private readonly tables = new Map<string, AddressLookupTableAccount>();
  private slot = 0;
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

  connection(): Connection {
    const { accounts, tables, blockhash, lastValidBlockHeight } = this;
    const nextSlot = () => (this.slot += 1);
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
        return { context: { slot: nextSlot() }, value: accounts.get(address.toBase58()) ?? null };
      },
      async getAddressLookupTable(key: PublicKey) {
        return { context: { slot: 1 }, value: tables.get(key.toBase58()) ?? null };
      },
    } as unknown as Connection;
  }
}
