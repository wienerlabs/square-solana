// Escrow hesaplarının testte kodlanması ve okunması (FE-17). Hesaplar escrow IDL'iyle (Borsh) kodlanır ve SDK'nın
// programıyla çözülür: arayüz zincirdekiyle aynı düzeni okur. `FakeChain` yalnızca verilen hesapları ve bir
// blockhash'i döndüren bir bağlantıdır; tx kurulur, gönderilmez.
import { BorshCoder, Program, type Idl } from '@anchor-lang/core';
import BN from 'bn.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
  type Commitment,
  type GetAccountInfoConfig,
} from '@solana/web3.js';
import {
  createSquareClient,
  SQUARE_IDLS,
  type EscrowConfigAccount,
  type JobAccount,
  type SquareClient,
} from '@squaresdk/solana-sdk';

export const key = () => Keypair.generate().publicKey;
export const coder = new BorshCoder(SQUARE_IDLS.escrow as unknown as Idl);
const reader = new Program(
  { ...SQUARE_IDLS.escrow, address: key().toBase58() },
  { connection: new Connection('http://127.0.0.1:9') },
);

export interface DisputeFields {
  challenger?: PublicKey;
  bond?: number | bigint;
  reason_hash?: number[];
  raised_at?: number;
  deadline?: number;
  decided_at?: number;
  closed_at?: number;
  lapsed?: boolean;
  approval_mask?: number;
  approval_count?: number;
  arbitrator_set_version?: number;
  resolution?: object;
}

export interface JobFields {
  institution: PublicKey;
  agent_wallet: PublicKey;
  mint: PublicKey;
  status?: string;
  amount?: bigint;
  challenge_end?: number;
  policy?: PublicKey | null;
  dispute?: DisputeFields;
}

const bn = (value: number | bigint) => new BN(value.toString());
const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** `Job` hesabının baytları; verilmeyen alanlar teslim edilmiş, dispute'suz bir iş gibi. */
export async function encodeJob(fields: JobFields): Promise<Buffer> {
  const d = fields.dispute ?? {};
  return coder.accounts.encode('Job', {
    institution: fields.institution,
    agent_record: key(),
    agent_wallet: fields.agent_wallet,
    mint: fields.mint,
    rent_payer: fields.institution,
    amount: bn(fields.amount ?? 250_000_000n),
    spec_hash: Array(32).fill(1),
    status: { [capital(fields.status ?? 'delivered')]: {} },
    created_at: bn(1_790_000_000),
    funded_at: bn(1_790_000_100),
    deadline: bn(1_790_086_400),
    challenge_period: bn(3_600),
    challenge_end: bn(fields.challenge_end ?? 1_790_010_000),
    delivered_at: bn(1_790_006_400),
    settled_at: bn(0),
    work_hash: Array(32).fill(2),
    travel_rule_commitment: Array(32).fill(0),
    policy_commitment: Array(32).fill(0),
    policy_daily_ceiling: bn(0),
    policy_version: 0,
    bump: 255,
    vault_bump: 254,
    bond_bump: d.raised_at ? 253 : 0,
    policy: fields.policy ?? null,
    dispute: {
      challenger: d.challenger ?? PublicKey.default,
      bond: bn(d.bond ?? 0),
      reason_hash: d.reason_hash ?? Array(32).fill(0),
      raised_at: bn(d.raised_at ?? 0),
      deadline: bn(d.deadline ?? 0),
      decided_at: bn(d.decided_at ?? 0),
      closed_at: bn(d.closed_at ?? 0),
      lapsed: d.lapsed ?? false,
      approval_mask: d.approval_mask ?? 0,
      approval_count: d.approval_count ?? 0,
      arbitrator_set_version: d.arbitrator_set_version ?? 0,
      resolution: d.resolution ?? { Pending: {} },
    },
    delivery_uri: 'https://deliveries.example.org/work',
    rail: { Escrow: {} },
  });
}

/** SDK'nın okuduğu biçimde (camelCase) `Job`. */
export async function jobAccount(fields: JobFields): Promise<JobAccount> {
  return reader.coder.accounts.decode('job', await encodeJob(fields)) as JobAccount;
}

export interface ConfigFields {
  arbitrators: PublicKey[];
  threshold: number;
  arbitrator_set_version?: number;
  min_bond_bps?: number;
  min_bond_absolute?: bigint;
  proof_timeout_secs?: number;
  dispute_timeout_secs?: number;
  settlement_mint?: PublicKey;
}

export async function encodeConfig(fields: ConfigFields): Promise<Buffer> {
  return coder.accounts.encode('EscrowConfig', {
    admin: key(),
    settlement_mint: fields.settlement_mint ?? key(),
    registry_program: key(),
    policy_program: key(),
    verifier_program: key(),
    arbitrators: [...fields.arbitrators, ...Array(7 - fields.arbitrators.length).fill(PublicKey.default)],
    arbitrator_count: fields.arbitrators.length,
    threshold: fields.threshold,
    arbitrator_set_version: fields.arbitrator_set_version ?? 0,
    params: {
      min_challenge_period: bn(60),
      max_challenge_period: bn(604_800),
      min_bond_bps: fields.min_bond_bps ?? 500,
      min_bond_absolute: bn(fields.min_bond_absolute ?? 1_000_000n),
      keeper_fee_bps: 50,
      proof_timeout_secs: bn(fields.proof_timeout_secs ?? 86_400),
      dispute_timeout_secs: bn(fields.dispute_timeout_secs ?? 259_200),
      travel_rule_threshold: bn(0),
    },
    bump: 254,
  });
}

export async function configAccount(fields: ConfigFields): Promise<EscrowConfigAccount> {
  return reader.coder.accounts.decode('escrowConfig', await encodeConfig(fields)) as EscrowConfigAccount;
}

/** Yalnızca verilen hesapları ve rastgele bir blockhash'i döndüren bağlantı. */
export class FakeChain extends Connection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();

  constructor() {
    super('http://127.0.0.1:9');
  }

  put(address: PublicKey, data: Buffer, owner: PublicKey): void {
    this.accounts.set(address.toBase58(), { data, owner, lamports: 1_000_000, executable: false, rentEpoch: 0 });
  }

  /** Token programına ait bir mint (SDK token programını sahibinden okur). */
  mint(address: PublicKey): void {
    this.put(address, Buffer.alloc(82), TOKEN_PROGRAM_ID);
  }

  override async getAccountInfo(address: PublicKey, _config?: Commitment | GetAccountInfoConfig) {
    return this.accounts.get(address.toBase58()) ?? null;
  }

  override async getAccountInfoAndContext(address: PublicKey, _config?: Commitment | GetAccountInfoConfig) {
    return { context: { slot: 1 }, value: this.accounts.get(address.toBase58()) ?? null };
  }

  override async getLatestBlockhash(_config?: Commitment) {
    return { blockhash: key().toBase58(), lastValidBlockHeight: 1 };
  }
}

/** Sahte zincire bağlı SDK istemcisi. */
export function fakeClient(chain: FakeChain, escrow: PublicKey, verifier = key()): SquareClient {
  return createSquareClient({
    connection: chain,
    commitment: 'confirmed',
    programIds: { registry: key(), policy: key(), verifier, escrow },
  });
}
