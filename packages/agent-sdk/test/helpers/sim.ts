// Test fixture: SDK'nın kullandığı RPC yöntemlerini bellekteki hesaplarla yanıtlayan bağlantı ve agent'ın
// gönderdiği tx'leri yürüten küçük bir zincir benzetimi. Tx imzaları Ed25519 ile doğrulanır, talimatlar IDL
// coder'ıyla çözülür; accept_job / submit_work / list_claim / register_agent / update_agent programların
// durum kurallarıyla (escrow `agent_job.rs`, `list_claim.rs`; registry `state.rs`) uygulanır. Kural ihlali,
// gerçek RPC gibi `Program <id> failed: custom program error` loglu bir gönderim hatası verir. Gerçek
// programlarla uçtan uca akış test/localnet.e2e.test.ts'dedir.
import { BN, type Idl, type Program } from '@anchor-lang/core';
import { ed25519 } from '@noble/curves/ed25519.js';
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
  accounts: PublicKey[];
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

export class SimChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly sent: SentInstruction[] = [];
  readonly genesisHash = Keypair.generate().publicKey.toBase58();
  readonly settlementMint = Keypair.generate().publicKey;
  readonly client: SquareClient;
  /** Verilirse adı eşleşen talimat bu hatayla düşer (ör. ağ hatası). */
  failure: ((name: string) => Error | null) | null = null;
  /** Verilirse adı eşleşen talimattan önce beklenir (ör. zincirdeki durumu değiştirmek için). */
  before: ((name: string) => Promise<void>) | null = null;
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

  async setConfig(): Promise<void> {
    const data = { ...this.sample(this.escrow, 'escrowConfig'), settlementMint: this.settlementMint };
    await this.put(this.client.pda.escrowConfig()[0], PROGRAM_IDS.escrow, this.escrow, 'escrowConfig', data);
  }

  async setJob(address: PublicKey, fields: JobFields): Promise<void> {
    const sample = this.sample(this.escrow, 'job');
    const data = {
      ...sample,
      institution: fields.institution,
      agentRecord: fields.agentRecord,
      agentWallet: fields.agentWallet,
      mint: this.settlementMint,
      amount: new BN(fields.amount.toString()),
      specHash: Array.from(Buffer.from(fields.specHash, 'hex')),
      status: { [fields.status]: {} },
      deadline: new BN(fields.deadline),
      workHash: new Array(32).fill(0),
      deliveryUri: '',
      policy: null,
      dispute: { ...(sample.dispute as object), bond: new BN(0) },
    };
    await this.put(address, PROGRAM_IDS.escrow, this.escrow, 'job', data);
  }

  /** Job hesabının alanlarını değiştirir (Anchor JS biçiminde). */
  async patchJob(address: PublicKey, patch: Record<string, unknown>): Promise<void> {
    const current = this.job(address);
    if (!current) throw new Error(`job hesabı yok: ${address.toBase58()}`);
    await this.put(address, PROGRAM_IDS.escrow, this.escrow, 'job', { ...current, ...patch });
  }

  job(address: PublicKey) {
    return this.decode<
      Record<string, unknown> & { status: Record<string, unknown>; deliveryUri: string; workHash: number[] }
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

  agentRecord(address: PublicKey) {
    return this.decode<{
      owner: PublicKey;
      wallet: PublicKey;
      agentCardUri: string;
      agentCardHash: number[];
      agentId: string;
    }>(this.registry, 'agentRecord', address);
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
      const accounts = ix.accountKeyIndexes.map((i) => keys[i]!);
      const isEscrow = programId.equals(PROGRAM_IDS.escrow);
      const program = isEscrow ? this.escrow : this.registry;
      if (!isEscrow && !programId.equals(PROGRAM_IDS.registry)) {
        throw new Error(`beklenmeyen program: ${programId.toBase58()}`);
      }
      // Anchor'ın Borsh coder'ı decode sunar; arayüz tipi yalnızca encode'u bildirir.
      const coder = program.coder.instruction as unknown as {
        decode(data: Buffer): { name: string; data: unknown } | null;
      };
      const decoded = coder.decode(Buffer.from(ix.data));
      if (!decoded) throw new Error('talimat çözülemedi');
      const sent: SentInstruction = {
        program: isEscrow ? 'escrow' : 'registry',
        name: decoded.name,
        data: decoded.data as Record<string, unknown>,
        accounts,
        signers,
      };
      await this.before?.(decoded.name);
      const injected = this.failure?.(decoded.name);
      if (injected) throw injected;
      if (isEscrow) await this.escrowIx(sent);
      else await this.registryIx(sent);
      this.sent.push(sent);
    }
  }

  private async escrowIx({ name, data, accounts, signers }: SentInstruction): Promise<void> {
    const idl = this.escrow.idl;
    const fail = (error: string) => this.fail(PROGRAM_IDS.escrow, idl, error);
    const jobAt = name === 'listClaim' ? 2 : 1;
    const address = accounts[jobAt]!;
    const job = this.job(address);
    if (!job) throw new Error(`job hesabı yok: ${address.toBase58()}`);
    const agent = accounts[name === 'listClaim' ? 1 : 0]!;
    if (!signers.includes(agent.toBase58())) throw new Error('agent imzalamadı');
    if (!(job.agentWallet as PublicKey).equals(agent)) return fail('AgentMismatch');
    const status = variant(job.status);
    if (name === 'acceptJob') {
      if (status === 'open') return fail('JobNotFunded');
      if (status !== 'funded') return fail('InvalidStatus');
      if (hex(data.specHash as number[]) !== hex(job.specHash as number[])) return fail('SpecHashMismatch');
      await this.put(address, PROGRAM_IDS.escrow, this.escrow, 'job', { ...job, status: { accepted: {} } });
    } else if (name === 'submitWork') {
      if (status !== 'accepted') return fail('InvalidStatus');
      if (Buffer.byteLength(data.deliveryUri as string) > 128) return fail('DeliveryUriTooLong');
      await this.put(address, PROGRAM_IDS.escrow, this.escrow, 'job', {
        ...job,
        status: { delivered: {} },
        workHash: data.workHash,
        deliveryUri: data.deliveryUri,
      });
    } else if (name === 'listClaim') {
      if (status !== 'delivered') return fail('InvalidStatus');
      const price = data.price as BN;
      if (price.lten(0) || price.gte(job.amount as BN)) return fail('InvalidClaimPrice');
      const listing = accounts[3]!;
      if (this.accounts.has(listing.toBase58())) throw new Error('claim_listing zaten var');
      await this.put(listing, PROGRAM_IDS.escrow, this.escrow, 'claimListing', {
        ...this.sample(this.escrow, 'claimListing'),
        job: address,
        seller: agent,
        price,
        faceValue: job.amount,
        status: { listed: {} },
      });
    } else {
      throw new Error(`benzetimde olmayan escrow talimatı: ${name}`);
    }
  }

  private async registryIx({ name, data, accounts, signers }: SentInstruction): Promise<void> {
    const fail = (error: string) => this.fail(PROGRAM_IDS.registry, this.registry.idl, error);
    const owner = accounts[name === 'registerAgent' ? 1 : 0]!;
    const record = accounts[name === 'registerAgent' ? 2 : 1]!;
    if (!signers.includes(owner.toBase58())) throw new Error('sahip imzalamadı');
    const uri = data.agentCardUri as string;
    const hash = data.agentCardHash as number[];
    if (Buffer.byteLength(uri) > 200) return fail('AgentCardUriTooLong');
    if ((uri === '') !== hash.every((b) => b === 0)) return fail('AgentCardHashInvalid');
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
