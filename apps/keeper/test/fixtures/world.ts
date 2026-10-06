// Test fixture: finalize'ın okuduğu zincir hesapları (IDL coder'ıyla kodlanmış) ve indexer'ın job aynası.
// Hesap değerleri IDL örneklerinden, senaryo alanları değiştirilerek üretilir.
import type { Idl, Program } from '@anchor-lang/core';
import { BN } from '@anchor-lang/core';
import {
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ACCOUNT_SIZE,
} from '@solana/spl-token';
import type { PrismaClient } from '@squaresdk/solana-db';
import {
  SQUARE_IDLS,
  createSquareClient,
  toIdlJson,
  type SquareClient,
  type SquareProgramIds,
  type SquareProgramName,
} from '@squaresdk/solana-sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { FixtureRpc } from './rpc.js';
import { sample } from './sample.js';

export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};

/** Senaryonun "şimdi"si (Unix saniyesi). */
export const NOW = 1_790_000_000;
export const AMOUNT = 1_000_000_000n;
export const KEEPER_FEE_BPS = 50;

export interface JobOptions {
  policy?: 'compliant' | 'refused' | 'missing';
  sold?: boolean;
  screening?: 'clear' | 'flagged' | 'none';
  challengeEnd?: number;
  status?: string;
  /** Varsayılan escrow; fiat iş `finalize_fiat_payment` ile kapanır (ADR 0024). */
  rail?: 'escrow' | 'fiat';
}

export class World {
  readonly client: SquareClient;
  readonly programs: Record<SquareProgramName, Program<Idl>>;
  readonly mint = Keypair.generate().publicKey;

  constructor(
    readonly rpc: FixtureRpc,
    /** Job aynası için; yalnızca zincir hesabı kuran testlerde null. */
    readonly db: PrismaClient | null,
    rpcUrl: string,
  ) {
    this.client = createSquareClient({
      connection: new Connection(rpcUrl, 'confirmed'),
      programIds: PROGRAM_IDS,
      commitment: 'confirmed',
    });
    this.programs = {
      registry: this.client.registry.program,
      policy: this.client.policy.program,
      verifier: this.client.verifier.program,
      escrow: this.client.escrow.program,
    } as unknown as Record<SquareProgramName, Program<Idl>>;
  }

  key = () => Keypair.generate().publicKey;

  sample(program: SquareProgramName, type: string, overrides: Record<string, unknown> = {}) {
    return sample(this.programs[program].idl, type, overrides);
  }

  async put(program: SquareProgramName, type: string, address: PublicKey, value: Record<string, unknown>) {
    const data = await this.programs[program].coder.accounts.encode(type, value);
    this.rpc.accounts.set(address.toBase58(), { owner: PROGRAM_IDS[program].toBase58(), data, lamports: 1_000_000 });
  }

  /** Escrow config ve settlement mint'i (SPL Token, 6 ondalık). */
  async setup(keeperFeeBps = KEEPER_FEE_BPS) {
    const mint = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 0n,
        decimals: 6,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      mint,
    );
    this.rpc.accounts.set(this.mint.toBase58(), {
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data: mint,
      lamports: 1_461_600,
    });
    const params = this.sample('escrow', 'escrowParams', { keeperFeeBps });
    await this.put(
      'escrow',
      'escrowConfig',
      this.client.pda.escrowConfig()[0],
      this.sample('escrow', 'escrowConfig', { settlementMint: this.mint, params }),
    );
  }

  /** Bir token hesabının zincirde var olması (sahibi token programı). */
  tokenAccount(owner: PublicKey) {
    const address = getAssociatedTokenAddressSync(this.mint, owner, true, TOKEN_PROGRAM_ID);
    this.rpc.accounts.set(address.toBase58(), {
      owner: TOKEN_PROGRAM_ID.toBase58(),
      data: Buffer.alloc(ACCOUNT_SIZE),
      lamports: 2_039_280,
    });
    return address;
  }

  /** Job'a bağlı, release'in hâline uyan `ReleaseProof` (zincirde). */
  async proof(
    job: { address: PublicKey; institution: PublicKey; policy: PublicKey | null; payee: PublicKey },
    verdict: 'compliant' | 'refused',
  ) {
    const fee = (AMOUNT * BigInt(KEEPER_FEE_BPS)) / 10_000n;
    await this.put(
      'verifier',
      'releaseProof',
      this.client.pda.releaseProof(job.address)[0],
      this.sample('verifier', 'releaseProof', {
        job: job.address,
        institution: job.institution,
        policy: job.policy,
        payee: job.payee,
        netAmount: new BN((AMOUNT - fee).toString()),
        mint: this.mint,
        verdict: { [verdict]: {} },
        consumed: false,
      }),
    );
  }

  /**
   * Dispute'lu job (lapse crank'i): zincirdeki job ve job / dispute ayna satırları. `deadline` zincirdeki,
   * `mirrorDeadline` (verilirse) aynadaki son tarihtir; `status` zincirdeki durum.
   */
  async disputed(options: { deadline: number; mirrorDeadline?: number; bond?: bigint; status?: string }) {
    const db = this.db;
    if (!db) throw new Error('dispute aynası için veritabanı gerekli');
    const address = this.key();
    const institution = this.key();
    const status = options.status ?? 'disputed';
    const dispute = this.sample('escrow', 'disputeInfo', {
      raisedAt: new BN(options.deadline - 86_400),
      deadline: new BN(options.deadline),
      bond: new BN((options.bond ?? 0n).toString()),
      lapsed: false,
      resolution: { pending: {} },
    });
    const value = this.sample('escrow', 'job', {
      institution,
      mint: this.mint,
      rentPayer: institution,
      amount: new BN(AMOUNT.toString()),
      status: { [status]: {} },
      dispute,
      policy: null,
    });
    await this.put('escrow', 'job', address, value);
    const account = toIdlJson(this.programs.escrow.idl, { defined: { name: 'job' } }, value) as Record<string, unknown>;
    const json = account.dispute as Record<string, number | string | boolean>;
    await db.job.create({
      data: {
        address: address.toBase58(),
        institution: institution.toBase58(),
        agentRecord: account.agentRecord as string,
        agentWallet: account.agentWallet as string,
        policy: null,
        mint: this.mint.toBase58(),
        amount: AMOUNT.toString(),
        specHash: account.specHash as string,
        status: 'disputed',
        createdAt: BigInt(account.createdAt as number),
        deadline: BigInt(account.deadline as number),
        challengeEnd: BigInt(account.challengeEnd as number),
        account: account as object,
        slot: 1n,
        indexedAt: new Date(NOW * 1000 - 120_000),
      },
    });
    await db.dispute.create({
      data: {
        job: address.toBase58(),
        institution: institution.toBase58(),
        agentRecord: account.agentRecord as string,
        jobStatus: 'disputed',
        challenger: institution.toBase58(),
        bond: (options.bond ?? 0n).toString(),
        reasonHash: json.reasonHash as string,
        raisedAt: BigInt(options.deadline - 86_400),
        deadline: BigInt(options.mirrorDeadline ?? options.deadline),
        decidedAt: 0n,
        closedAt: 0n,
        resolution: 'pending',
        lapsed: false,
        approvalMask: 0,
        approvalCount: 0,
        arbitratorSetVersion: 1n,
        slot: 1n,
        indexedAt: new Date(NOW * 1000 - 120_000),
      },
    });
    return { address, institution, value };
  }

  /** Finalize'a hazır (ya da seçeneklerle bekleyen) job: zincir hesapları ve ayna satırı. */
  async job(options: JobOptions = {}) {
    const db = this.db;
    if (!db) throw new Error('job aynası için veritabanı gerekli');
    const address = this.key();
    const institution = this.key();
    const agentWallet = this.key();
    const buyer = this.key();
    const agentRecord = this.key();
    const payee = options.sold ? buyer : agentWallet;
    const policy = options.policy ? this.key() : null;
    const status = options.status ?? 'delivered';
    const challengeEnd = options.challengeEnd ?? NOW - 60;
    const value = this.sample('escrow', 'job', {
      institution,
      agentRecord,
      agentWallet,
      mint: this.mint,
      rentPayer: institution,
      amount: new BN(AMOUNT.toString()),
      status: { [status]: {} },
      challengeEnd: new BN(challengeEnd),
      policy,
      rail: { [options.rail ?? 'escrow']: {} },
    });
    await this.put('escrow', 'job', address, value);
    if (options.sold) {
      await this.put(
        'escrow',
        'claimListing',
        this.client.pda.claimListing(address)[0],
        this.sample('escrow', 'claimListing', { job: address, buyer, status: { bought: {} } }),
      );
    }
    if (policy) {
      await this.put('policy', 'policy', policy, this.sample('policy', 'policy', { institution }));
      if (options.policy !== 'missing') {
        await this.proof({ address, institution, policy, payee }, options.policy as 'compliant' | 'refused');
      }
    }
    if ((options.screening ?? 'clear') !== 'none') {
      await this.put(
        'registry',
        'screeningRecord',
        this.client.pda.screeningRecord(payee)[0],
        this.sample('registry', 'screeningRecord', {
          wallet: payee,
          status: { [options.screening ?? 'clear']: {} },
          expiresAt: new BN(NOW + 86_400),
        }),
      );
    }
    const account = toIdlJson(this.programs.escrow.idl, { defined: { name: 'job' } }, value) as Record<string, unknown>;
    await db.job.create({
      data: {
        address: address.toBase58(),
        institution: institution.toBase58(),
        agentRecord: agentRecord.toBase58(),
        agentWallet: agentWallet.toBase58(),
        policy: policy?.toBase58() ?? null,
        mint: this.mint.toBase58(),
        amount: AMOUNT.toString(),
        specHash: account.specHash as string,
        status: status as 'delivered',
        createdAt: BigInt(account.createdAt as number),
        deadline: BigInt(account.deadline as number),
        challengeEnd: BigInt(challengeEnd),
        rail: options.rail ?? 'escrow',
        account: account as object,
        slot: 1n,
        indexedAt: new Date(NOW * 1000 - 120_000),
      },
    });
    return { address, institution, agentWallet, buyer, agentRecord, payee, policy };
  }
}
