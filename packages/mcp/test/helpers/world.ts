// Test dünyası: Square programları (IDL'lerdeki kimlikler), escrow config'i, 6 ondalıklı settlement mint'i, job'lar,
// agent kayıtları, itibar ve alacak listelemesi; hesaplar programların coder'ıyla kodlanır.
import { BN, type Idl, type Program } from '@anchor-lang/core';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createSquareClient, SQUARE_IDLS, type SquareClient, type SquareProgramIds } from '@squaresdk/solana-sdk';
import type { SquareMcpConfig } from '../../src/config.js';
import { TestChain } from './chain.js';
import { createSampler } from './idl-sample.js';

export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};
export const USDC = Keypair.generate().publicKey;

export function config(overrides: Partial<SquareMcpConfig> = {}): SquareMcpConfig {
  return {
    cluster: 'devnet',
    rpcUrl: 'https://rpc.test',
    programIds: PROGRAM_IDS,
    timeoutMs: 2_000,
    cardMaxBytes: 65_536,
    signer: null,
    lookupTable: null,
    computeUnitPrice: null,
    api: null,
    ...overrides,
  };
}

export class World {
  readonly chain = new TestChain();
  readonly connection = this.chain.connection();
  readonly client: SquareClient = createSquareClient({
    connection: this.connection,
    programIds: PROGRAM_IDS,
    commitment: 'confirmed',
  });
  private readonly escrow = this.client.escrow.program as unknown as Program<Idl>;
  private readonly registry = this.client.registry.program as unknown as Program<Idl>;

  async init(): Promise<this> {
    const escrowConfig = createSampler(this.escrow.idl).struct('escrowConfig');
    const params = escrowConfig['params'] as Record<string, unknown>;
    await this.write(this.escrow, 'escrowConfig', this.client.pda.escrowConfig()[0], {
      ...escrowConfig,
      settlementMint: USDC,
      params: { ...params, minChallengePeriod: new BN(60), maxChallengePeriod: new BN(604_800) },
    });
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
    this.chain.setAccount(USDC, TOKEN_PROGRAM_ID, mint);
    return this;
  }

  private async write(program: Program<Idl>, type: string, address: PublicKey, data: Record<string, unknown>) {
    this.chain.setAccount(address, program.programId, await program.coder.accounts.encode(type, data));
    return address;
  }

  /** Agent kaydı; itibar verilirse escrow'un AgentReputation hesabı da yazılır. */
  async agent(
    options: {
      owner?: PublicKey;
      status?: string;
      agentId?: string;
      agentCardUri?: string;
      agentCardHash?: Uint8Array;
      reputation?: { completed: number; earned: number };
    } = {},
  ) {
    const address = Keypair.generate().publicKey;
    const owner = options.owner ?? Keypair.generate().publicKey;
    await this.write(this.registry, 'agentRecord', address, {
      ...createSampler(this.registry.idl).struct('agentRecord'),
      creator: owner,
      owner,
      wallet: owner,
      status: { [options.status ?? 'active']: {} },
      agentId: options.agentId ?? 'agent',
      agentCardUri: options.agentCardUri ?? '',
      agentCardHash: Array.from(options.agentCardHash ?? new Uint8Array(32)),
    });
    if (options.reputation) {
      await this.write(this.escrow, 'agentReputation', this.client.pda.agentReputation(address)[0], {
        ...createSampler(this.escrow.idl).struct('agentReputation'),
        agentRecord: address,
        jobsCompleted: new BN(options.reputation.completed),
        totalEarned: new BN(options.reputation.earned),
        firstJobAt: new BN(1_791_000_000),
        lastJobAt: new BN(1_791_100_000),
      });
    }
    return { address, owner };
  }

  async job(
    options: {
      status?: string;
      agentRecord?: PublicKey;
      agentWallet?: PublicKey;
      institution?: PublicKey;
      amount?: number;
      mint?: PublicKey;
      createdAt?: number;
    } = {},
  ) {
    const address = Keypair.generate().publicKey;
    const data = createSampler(this.escrow.idl).struct('job');
    await this.write(this.escrow, 'job', address, {
      ...data,
      dispute: { ...(data['dispute'] as Record<string, unknown>), bond: new BN(0) },
      policy: null,
      institution: options.institution ?? Keypair.generate().publicKey,
      agentRecord: options.agentRecord ?? Keypair.generate().publicKey,
      agentWallet: options.agentWallet ?? Keypair.generate().publicKey,
      mint: options.mint ?? USDC,
      amount: new BN(options.amount ?? 5_000_000),
      status: { [options.status ?? 'funded']: {} },
      createdAt: new BN(options.createdAt ?? 1_791_000_000),
      deadline: new BN(1_791_600_000),
      deliveryUri: '',
    });
    return address;
  }

  async claim(job: PublicKey) {
    await this.write(this.escrow, 'claimListing', this.client.pda.claimListing(job)[0], {
      ...createSampler(this.escrow.idl).struct('claimListing'),
      job,
      status: { listed: {} },
    });
  }

  /** Square'in akışlarının okuduğu hesaplar: kurumun ve agent'ın screening kaydı, agent kaydı. */
  async screening(wallet: PublicKey) {
    await this.write(this.registry, 'screeningRecord', this.client.pda.screeningRecord(wallet)[0], {
      ...createSampler(this.registry.idl).struct('screeningRecord'),
      wallet,
      status: { clear: {} },
      expiresAt: new BN(4_000_000_000),
    });
  }
}
