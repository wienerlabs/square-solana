// Test fixture: smart account ve sponsorlu gönderim kodunun kullandığı `Connection` yöntemlerini bellekteki hesaplarla
// yanıtlar. Hesap verileri resmi kodlayıcılarla (`@sqds/multisig`) üretilir; simülasyon ve onay yanıtları sırayla
// verilir. Programların kendisi burada çalışmaz: zincirdeki davranış localnet uçtan uca testindedir.
import * as squads from '@sqds/multisig';
import { SQUADS_PROGRAM_ID, squadsProposalAddress, squadsTransactionAddress } from '@squaresdk/solana-sdk/squads';
import { PublicKey, type AddressLookupTableAccount, type Connection, type VersionedTransaction } from '@solana/web3.js';

export const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

export interface Simulation {
  err: unknown;
  logs: string[];
  unitsConsumed: number;
}

export class FakeChain {
  readonly accounts = new Map<string, { owner: PublicKey; data: Buffer; lamports: number }>();
  readonly tables = new Map<string, AddressLookupTableAccount>();
  /** Sonraki simülasyonların sonucu (sırayla); boşsa 50 bin CU'luk başarılı simülasyon. */
  readonly simulations: Simulation[] = [];
  readonly simulated: VersionedTransaction[] = [];
  /** Sonraki onayların hatası (sırayla); boşsa başarılı. */
  readonly confirmations: unknown[] = [];
  readonly confirmed: string[] = [];

  set(address: PublicKey, owner: PublicKey, data: Buffer, lamports = 1_000_000): void {
    this.accounts.set(address.toBase58(), { owner, data, lamports });
  }

  get connection(): Connection {
    return this as unknown as Connection;
  }

  async getAccountInfo(address: PublicKey) {
    const account = this.accounts.get(address.toBase58());
    return account ? { ...account, executable: false, rentEpoch: 0 } : null;
  }

  async getMultipleAccountsInfo(addresses: PublicKey[]) {
    return Promise.all(addresses.map((address) => this.getAccountInfo(address)));
  }

  async getBalance(address: PublicKey) {
    return this.accounts.get(address.toBase58())?.lamports ?? 0;
  }

  async getLatestBlockhash() {
    return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 };
  }

  async simulateTransaction(transaction: VersionedTransaction) {
    this.simulated.push(transaction);
    const next = this.simulations.shift() ?? { err: null, logs: [], unitsConsumed: 50_000 };
    return { context: { slot: 1 }, value: { ...next, accounts: null, returnData: null } };
  }

  async getAddressLookupTable(address: PublicKey) {
    return { context: { slot: 1 }, value: this.tables.get(address.toBase58()) ?? null };
  }

  async confirmTransaction(strategy: { signature: string }) {
    this.confirmed.push(strategy.signature);
    return { context: { slot: 1 }, value: { err: this.confirmations.shift() ?? null } };
  }
}

/** Squads v4 `Multisig` hesabı. */
export function putMultisig(
  chain: FakeChain,
  address: PublicKey,
  params: {
    members: readonly { key: PublicKey; permissions: number }[];
    threshold: number;
    timeLock?: number;
    transactionIndex?: number;
    staleTransactionIndex?: number;
  },
): void {
  const [data] = squads.accounts.Multisig.fromArgs({
    createKey: PublicKey.unique(),
    configAuthority: PublicKey.default,
    threshold: params.threshold,
    timeLock: params.timeLock ?? 0,
    transactionIndex: params.transactionIndex ?? 0,
    staleTransactionIndex: params.staleTransactionIndex ?? 0,
    rentCollector: null,
    bump: 254,
    members: params.members.map((member) => ({ key: member.key, permissions: { mask: member.permissions } })),
  }).serialize();
  chain.set(address, SQUADS_PROGRAM_ID, data);
}

/** Squads v4 `Proposal` hesabı ve (verilirse) iç talimatın programıyla `VaultTransaction`'ı. */
export function putProposal(
  chain: FakeChain,
  multisig: PublicKey,
  index: number,
  params: {
    status: squads.generated.ProposalStatus;
    approved?: readonly PublicKey[];
    rejected?: readonly PublicKey[];
    program?: PublicKey;
    vault?: PublicKey;
  },
): void {
  const [proposal] = squads.accounts.Proposal.fromArgs({
    multisig,
    transactionIndex: index,
    status: params.status,
    bump: 253,
    approved: [...(params.approved ?? [])],
    rejected: [...(params.rejected ?? [])],
    cancelled: [],
  }).serialize();
  chain.set(squadsProposalAddress(multisig, BigInt(index))[0], SQUADS_PROGRAM_ID, proposal);
  if (!params.program || !params.vault) return;
  const [transaction] = squads.accounts.VaultTransaction.fromArgs({
    multisig,
    creator: params.approved?.[0] ?? PublicKey.unique(),
    index,
    bump: 252,
    vaultIndex: 0,
    vaultBump: 251,
    ephemeralSignerBumps: new Uint8Array(),
    message: {
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 0,
      accountKeys: [params.vault, params.program],
      instructions: [{ programIdIndex: 1, accountIndexes: Uint8Array.from([0]), data: Uint8Array.from([1, 2, 3]) }],
      addressTableLookups: [],
    },
  }).serialize();
  chain.set(squadsTransactionAddress(multisig, BigInt(index))[0], SQUADS_PROGRAM_ID, transaction);
}
