// Test fixture: SDK'nın kullandığı RPC yöntemlerini bellekteki hesaplarla yanıtlayan bağlantı ve gönderilen tx'leri
// yürüten zincir benzetimi. packages/agent-sdk/test/helpers/sim.ts'in genişletilmiş hâli: agent tarafı (accept_job,
// submit_work, list_claim, register_agent, update_agent) yanında kurum tarafı (create_job, commit_travel_rule,
// fund_job) ve dispute crank'i (execute_resolution, lapse_dispute). Tx imzaları Ed25519 ile doğrulanır, talimatlar
// IDL coder'ıyla çözülür, hesaplar IDL'deki adlarıyla eşlenir ve programların durum kurallarıyla uygulanır. Kural
// ihlali gerçek RPC gibi `custom program error` loglu gönderim hatası verir. Gerçek programlarla akış
// test/localnet.e2e.test.ts'dedir.
import { BN, type Idl, type Program } from '@anchor-lang/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js';
import { createSquareClient, SQUARE_IDLS, type SquareClient, type SquareProgramIds } from '@squaresdk/solana-sdk';
import type { JobStatus } from '@squaresdk/solana-types';
import { createSampler } from './idl-sample.js';

export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};

export interface SentInstruction {
  program: 'escrow' | 'registry';
  name: string;
  data: Record<string, unknown>;
  accounts: Record<string, PublicKey>;
  signers: string[];
}

export interface JobFields {
  institution: PublicKey;
  agentRecord: PublicKey;
  agentWallet: PublicKey;
  amount: bigint;
  specHash: string;
  status: JobStatus;
  deadline: number;
  policy?: PublicKey | null;
  dispute?: { bond: bigint; deadline: number };
}

class ProgramFailure extends Error {
  constructor(
    readonly logs: string[],
    message: string,
  ) {
    super(message);
  }
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('hex');
const variant = (status: Record<string, unknown>) => Object.keys(status)[0]!;
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export class SimChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly sent: SentInstruction[] = [];
  /** Talimatı olmayan programlara giden çağrılar (ATA açılışı); program adresiyle. */
  readonly other: string[] = [];
  readonly genesisHash = Keypair.generate().publicKey.toBase58();
  readonly settlementMint = Keypair.generate().publicKey;
  readonly client: SquareClient;
  /** Zincirin saati (unix saniyesi); dispute son tarihi buna göre. */
  clock = Math.floor(Date.now() / 1000);
  /** Verilirse adı eşleşen talimat bu hatayla düşer. */
  failure: ((name: string) => Error | null) | null = null;
  private slot = 0;
  private signatures = 0;

  constructor() {
    this.client = createSquareClient({
      connection: this.connection(),
      programIds: PROGRAM_IDS,
      commitment: 'confirmed',
    });
  }

  private get escrow() {
    return this.client.escrow.program as unknown as Program<Idl>;
  }

  private get registry() {
    return this.client.registry.program as unknown as Program<Idl>;
  }

  private sample(program: Program<Idl>, name: string) {
    return createSampler(program.idl).struct(name);
  }

  private async put(address: PublicKey, owner: PublicKey, program: Program<Idl>, name: string, data: unknown) {
    const encoded = await program.coder.accounts.encode(name, data);
    this.accounts.set(address.toBase58(), {
      data: encoded,
      owner,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    });
  }

  private decode<T>(program: Program<Idl>, name: string, address: PublicKey): T | null {
    const info = this.accounts.get(address.toBase58());
    return info ? program.coder.accounts.decode<T>(name, info.data) : null;
  }

  /** Escrow config'i ve settlement mint hesabı (SPL Token sahipli). */
  async setConfig(params: { travelRuleThreshold?: bigint } = {}): Promise<void> {
    const sample = this.sample(this.escrow, 'escrowConfig') as { params: Record<string, unknown> };
    const data = {
      ...sample,
      settlementMint: this.settlementMint,
      params: { ...sample.params, travelRuleThreshold: new BN((params.travelRuleThreshold ?? 0n).toString()) },
    };
    await this.put(this.client.pda.escrowConfig()[0], PROGRAM_IDS.escrow, this.escrow, 'escrowConfig', data);
    this.accounts.set(this.settlementMint.toBase58(), {
      data: Buffer.alloc(82),
      owner: TOKEN_PROGRAM_ID,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    });
  }

  /** Registry'de agent kaydı. */
  async setAgentRecord(address: PublicKey, wallet: PublicKey, owner = wallet): Promise<void> {
    await this.put(address, PROGRAM_IDS.registry, this.registry, 'agentRecord', {
      ...this.sample(this.registry, 'agentRecord'),
      owner,
      creator: owner,
      wallet,
      agentCardUri: '',
      agentCardHash: new Array(32).fill(0),
      agentId: 'sim',
      status: { active: {} },
    });
  }

  async setJob(address: PublicKey, fields: JobFields): Promise<void> {
    const sample = this.sample(this.escrow, 'job');
    const data = {
      ...sample,
      institution: fields.institution,
      agentRecord: fields.agentRecord,
      agentWallet: fields.agentWallet,
      mint: this.settlementMint,
      rentPayer: fields.institution,
      amount: new BN(fields.amount.toString()),
      specHash: Array.from(Buffer.from(fields.specHash, 'hex')),
      status: { [fields.status]: {} },
      deadline: new BN(fields.deadline),
      workHash: new Array(32).fill(0),
      travelRuleCommitment: new Array(32).fill(0),
      deliveryUri: '',
      policy: fields.policy ?? null,
      dispute: {
        ...(sample.dispute as object),
        bond: new BN((fields.dispute?.bond ?? 0n).toString()),
        deadline: new BN(fields.dispute?.deadline ?? 0),
        lapsed: false,
      },
    };
    await this.put(address, PROGRAM_IDS.escrow, this.escrow, 'job', data);
  }

  job(address: PublicKey) {
    return this.decode<
      Record<string, unknown> & {
        status: Record<string, unknown>;
        deliveryUri: string;
        workHash: number[];
        travelRuleCommitment: number[];
        amount: BN;
        agentWallet: PublicKey;
        dispute: { lapsed: boolean; bond: BN };
      }
    >(this.escrow, 'job', address);
  }

  jobStatus(address: PublicKey): string | null {
    const job = this.job(address);
    return job ? variant(job.status) : null;
  }

  claimListing(job: PublicKey) {
    return this.decode<{ price: BN; seller: PublicKey; faceValue: BN }>(
      this.escrow,
      'claimListing',
      this.client.pda.claimListing(job)[0],
    );
  }

  private fail(program: PublicKey, idl: Idl, name: string): never {
    const code = (idl.errors ?? []).find((e) => e.name.toLowerCase() === name.toLowerCase())?.code;
    if (code === undefined) throw new Error(`IDL'de hata yok: ${name}`);
    const id = program.toBase58();
    throw new ProgramFailure(
      [`Program ${id} invoke [1]`, `Program ${id} failed: custom program error: 0x${code.toString(16)}`],
      `Simulation failed: ${name}`,
    );
  }

  private named(program: Program<Idl>, name: string, keys: PublicKey[]): Record<string, PublicKey> {
    const ix = program.idl.instructions.find((item) => camel(item.name) === name);
    if (!ix) throw new Error(`IDL'de talimat yok: ${name}`);
    return Object.fromEntries(ix.accounts.map((account, i) => [camel(account.name), keys[i]!]));
  }

  private async execute(tx: VersionedTransaction): Promise<void> {
    const message = tx.message;
    const keys = message.staticAccountKeys;
    const required = keys.slice(0, message.header.numRequiredSignatures);
    const bytes = message.serialize();
    required.forEach((key, i) => {
      if (!ed25519.verify(tx.signatures[i]!, bytes, key.toBytes())) {
        throw new Error(`imza eksik ya da geçersiz: ${key.toBase58()}`);
      }
    });
    const signers = required.map((key) => key.toBase58());
    for (const ix of message.compiledInstructions) {
      const programId = keys[ix.programIdIndex]!;
      if (programId.equals(ComputeBudgetProgram.programId)) continue;
      if (programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        this.other.push(programId.toBase58());
        continue;
      }
      const isEscrow = programId.equals(PROGRAM_IDS.escrow);
      if (!isEscrow && !programId.equals(PROGRAM_IDS.registry)) {
        throw new Error(`beklenmeyen program: ${programId.toBase58()}`);
      }
      const program = isEscrow ? this.escrow : this.registry;
      const coder = program.coder.instruction as unknown as {
        decode(data: Buffer): { name: string; data: unknown } | null;
      };
      const decoded = coder.decode(Buffer.from(ix.data));
      if (!decoded) throw new Error('talimat çözülemedi');
      const sent: SentInstruction = {
        program: isEscrow ? 'escrow' : 'registry',
        name: decoded.name,
        data: decoded.data as Record<string, unknown>,
        accounts: this.named(
          program,
          decoded.name,
          ix.accountKeyIndexes.map((i) => keys[i]!),
        ),
        signers,
      };
      const injected = this.failure?.(decoded.name);
      if (injected) throw injected;
      if (isEscrow) await this.escrowIx(sent);
      else await this.registryIx(sent);
      this.sent.push(sent);
    }
  }

  private signed(sent: SentInstruction, role: string): PublicKey {
    const key = sent.accounts[role]!;
    if (!sent.signers.includes(key.toBase58())) throw new Error(`${role} imzalamadı`);
    return key;
  }

  private async escrowIx(sent: SentInstruction): Promise<void> {
    const { name, data, accounts } = sent;
    const fail = (error: string) => this.fail(PROGRAM_IDS.escrow, this.escrow.idl, error);
    const config = this.decode<{ settlementMint: PublicKey; params: { travelRuleThreshold: BN } }>(
      this.escrow,
      'escrowConfig',
      this.client.pda.escrowConfig()[0],
    )!;
    const address = accounts.job!;
    if (name === 'createJob') {
      const institution = this.signed(sent, 'institution');
      if (this.accounts.has(address.toBase58())) throw new Error('job zaten var');
      const specHash = data.specHash as number[];
      if (!this.client.pda.job(institution, Uint8Array.from(specHash))[0].equals(address)) {
        throw new Error('ConstraintSeeds');
      }
      const record = this.decode<{ wallet: PublicKey }>(this.registry, 'agentRecord', accounts.agentRecord!);
      if (!record) return fail('AgentNotRegistered');
      if (!accounts.mint!.equals(config.settlementMint)) return fail('MintMismatch');
      const policy = accounts.policy!.equals(PROGRAM_IDS.escrow) ? null : accounts.policy!;
      await this.put(address, PROGRAM_IDS.escrow, this.escrow, 'job', {
        ...this.sample(this.escrow, 'job'),
        institution,
        agentRecord: accounts.agentRecord,
        agentWallet: record.wallet,
        mint: config.settlementMint,
        rentPayer: accounts.payer,
        amount: data.amount,
        specHash,
        status: { open: {} },
        createdAt: new BN(this.clock),
        deadline: data.deadline,
        challengePeriod: data.challengePeriod,
        workHash: new Array(32).fill(0),
        travelRuleCommitment: new Array(32).fill(0),
        policy,
        deliveryUri: '',
        dispute: { ...(this.sample(this.escrow, 'job').dispute as object), bond: new BN(0) },
      });
      return;
    }
    const job = this.job(address);
    if (!job) throw new Error(`job hesabı yok: ${address.toBase58()}`);
    const status = variant(job.status);
    const write = (patch: Record<string, unknown>) =>
      this.put(address, PROGRAM_IDS.escrow, this.escrow, 'job', { ...job, ...patch });
    if (name === 'commitTravelRule' || name === 'fundJob') {
      const institution = this.signed(sent, 'institution');
      if (!(job.institution as PublicKey).equals(institution)) return fail('Unauthorized');
      if (status !== 'open') return fail('InvalidStatus');
      if (name === 'commitTravelRule') return write({ travelRuleCommitment: data.commitment });
      const threshold = config.params.travelRuleThreshold;
      if (!threshold.isZero() && job.amount.gte(threshold) && job.travelRuleCommitment.every((b) => b === 0)) {
        return fail('TravelRuleCommitmentRequired');
      }
      return write({ status: { funded: {} }, fundedAt: new BN(this.clock) });
    }
    if (name === 'executeResolution') {
      this.signed(sent, 'payer');
      if (status !== 'resolved') return fail('InvalidStatus');
      return write({ status: { released: {} }, settledAt: new BN(this.clock) });
    }
    if (name === 'lapseDispute') {
      this.signed(sent, 'caller');
      if (status !== 'disputed') return fail('NoActiveDispute');
      const dispute = job.dispute as unknown as { deadline: BN; bond: BN };
      if (this.clock < dispute.deadline.toNumber()) return fail('DisputeNotExpired');
      const bondVault = accounts.bondVault!.equals(PROGRAM_IDS.escrow) ? null : accounts.bondVault!;
      if (!dispute.bond.isZero() && !bondVault) return fail('InvalidStatus');
      return write({
        status: { delivered: {} },
        dispute: { ...job.dispute, lapsed: true, closedAt: new BN(this.clock) },
      });
    }
    const agent = this.signed(sent, 'agent');
    if (!job.agentWallet.equals(agent)) return fail('AgentMismatch');
    if (name === 'acceptJob') {
      if (status === 'open') return fail('JobNotFunded');
      if (status !== 'funded') return fail('InvalidStatus');
      if (hex(data.specHash as number[]) !== hex(job.specHash as number[])) return fail('SpecHashMismatch');
      return write({ status: { accepted: {} } });
    }
    if (name === 'submitWork') {
      if (status !== 'accepted') return fail('InvalidStatus');
      if (Buffer.byteLength(data.deliveryUri as string) > 128) return fail('DeliveryUriTooLong');
      return write({ status: { delivered: {} }, workHash: data.workHash, deliveryUri: data.deliveryUri });
    }
    if (name === 'listClaim') {
      if (status !== 'delivered') return fail('InvalidStatus');
      const price = data.price as BN;
      if (price.lten(0) || price.gte(job.amount)) return fail('InvalidClaimPrice');
      await this.put(accounts.claimListing!, PROGRAM_IDS.escrow, this.escrow, 'claimListing', {
        ...this.sample(this.escrow, 'claimListing'),
        job: address,
        seller: agent,
        price,
        faceValue: job.amount,
        status: { listed: {} },
      });
      return;
    }
    throw new Error(`benzetimde olmayan escrow talimatı: ${name}`);
  }

  private async registryIx(sent: SentInstruction): Promise<void> {
    const { name, data, accounts } = sent;
    const fail = (error: string) => this.fail(PROGRAM_IDS.registry, this.registry.idl, error);
    const owner = this.signed(sent, 'owner');
    const record = accounts.agentRecord!;
    const uri = data.agentCardUri as string;
    const hash = data.agentCardHash as number[];
    if (Buffer.byteLength(uri) > 200) return fail('AgentCardUriTooLong');
    if (name === 'registerAgent') {
      const agentId = data.agentId as string;
      if (!this.client.pda.agentRecord(owner, agentId)[0].equals(record)) throw new Error('ConstraintSeeds');
      if (this.accounts.has(record.toBase58())) throw new Error('kayıt zaten var');
      await this.put(record, PROGRAM_IDS.registry, this.registry, 'agentRecord', {
        ...this.sample(this.registry, 'agentRecord'),
        creator: owner,
        owner,
        wallet: data.wallet,
        agentCardHash: hash,
        agentCardUri: uri,
        agentId,
        status: { active: {} },
      });
    } else if (name === 'updateAgent') {
      const current = this.decode<Record<string, unknown>>(this.registry, 'agentRecord', record);
      if (!current) throw new Error(`kayıt yok: ${record.toBase58()}`);
      if (!(current.owner as PublicKey).equals(owner)) return fail('Unauthorized');
      await this.put(record, PROGRAM_IDS.registry, this.registry, 'agentRecord', {
        ...current,
        wallet: data.wallet,
        agentCardHash: hash,
        agentCardUri: uri,
      });
    } else {
      throw new Error(`benzetimde olmayan registry talimatı: ${name}`);
    }
  }

  connection(): Connection {
    const nextSlot = () => (this.slot += 1);
    const accounts = this.accounts;
    return {
      commitment: 'confirmed',
      rpcEndpoint: 'sim-chain',
      getGenesisHash: async () => this.genesisHash,
      getLatestBlockhash: async () => ({
        blockhash: new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toBase58(),
        lastValidBlockHeight: 4242,
      }),
      getAccountInfo: async (address: PublicKey) => accounts.get(address.toBase58()) ?? null,
      getAccountInfoAndContext: async (address: PublicKey) => ({
        context: { slot: nextSlot() },
        value: accounts.get(address.toBase58()) ?? null,
      }),
      getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
        addresses.map((address) => accounts.get(address.toBase58()) ?? null),
      sendRawTransaction: async (raw: Uint8Array) => {
        await this.execute(VersionedTransaction.deserialize(raw));
        this.signatures += 1;
        return `sim${this.signatures.toString().padStart(60, '1')}`;
      },
      confirmTransaction: async () => ({ context: { slot: nextSlot() }, value: { err: null } }),
    } as unknown as Connection;
  }
}
