// Test fixture: sunucunun okuduğu RPC yöntemlerini bellekteki hesaplarla yanıtlayan bağlantı. `getProgramAccounts`
// süzgeçleri (memcmp, dataSize) ve `dataSlice` uygulanır. Gönderilen tx'ler kaydedilir.
import {
  AddressLookupTableAccount,
  PublicKey,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
  type GetProgramAccountsFilter,
} from '@solana/web3.js';
import bs58 from 'bs58';

export class TestChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly tables = new Map<string, AddressLookupTableAccount>();
  readonly sent: VersionedTransaction[] = [];
  /** Gönderilen tx'in onay sonucu (`err`). */
  sendResult: unknown = null;
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

  private matches(data: Buffer, filters: GetProgramAccountsFilter[]): boolean {
    return filters.every((filter) => {
      if ('dataSize' in filter) return data.length === filter.dataSize;
      const bytes = Buffer.from(bs58.decode(filter.memcmp.bytes));
      return data.subarray(filter.memcmp.offset, filter.memcmp.offset + bytes.length).equals(bytes);
    });
  }

  connection(): Connection {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- yöntemler aynı durumu paylaşır.
    const chain = this;
    const get = (address: PublicKey) => chain.accounts.get(address.toBase58()) ?? null;
    return {
      commitment: 'confirmed',
      rpcEndpoint: 'test-chain',
      async getLatestBlockhash() {
        return { blockhash: chain.blockhash, lastValidBlockHeight: chain.lastValidBlockHeight };
      },
      async getAccountInfo(address: PublicKey) {
        return get(address);
      },
      async getAccountInfoAndContext(address: PublicKey) {
        return { context: { slot: 1 }, value: get(address) };
      },
      async getMultipleAccountsInfo(addresses: PublicKey[]) {
        return addresses.map(get);
      },
      async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) {
        return { context: { slot: 1 }, value: addresses.map(get) };
      },
      async getProgramAccounts(
        program: PublicKey,
        config?: { filters?: GetProgramAccountsFilter[]; dataSlice?: { offset: number; length: number } },
      ) {
        return [...chain.accounts.entries()]
          .filter(([, account]) => account.owner.equals(program) && chain.matches(account.data, config?.filters ?? []))
          .map(([address, account]) => ({
            pubkey: new PublicKey(address),
            account: config?.dataSlice
              ? {
                  ...account,
                  data: account.data.subarray(
                    config.dataSlice.offset,
                    config.dataSlice.offset + config.dataSlice.length,
                  ),
                }
              : account,
          }));
      },
      async getAddressLookupTable(key: PublicKey) {
        return { context: { slot: 1 }, value: chain.tables.get(key.toBase58()) ?? null };
      },
      async sendRawTransaction(raw: Uint8Array) {
        const tx = VersionedTransaction.deserialize(raw);
        chain.sent.push(tx);
        return bs58.encode(tx.signatures[0]!);
      },
      async confirmTransaction() {
        return { context: { slot: 1 }, value: { err: chain.sendResult } };
      },
    } as unknown as Connection;
  }
}
