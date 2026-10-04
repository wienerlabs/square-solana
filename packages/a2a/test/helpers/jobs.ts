// Test fixture: escrow `Job` hesaplarını IDL coder'ıyla kodlayıp test zincirine koyar; testler job
// durumunu değiştirerek agent'ın kabul ve teslim tx'lerinin zincirdeki etkisini taklit eder.
import { BN, type Idl, type Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { createSquareClient, SQUARE_IDLS, type SquareClient, type SquareProgramIds } from '@squaresdk/solana-sdk';
import type { JobStatus } from '@squaresdk/solana-types';
import { TestChain } from './chain.js';
import { INSTITUTION } from './fixtures.js';
import { createSampler } from './idl-sample.js';

const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};

export interface JobFields {
  status: JobStatus;
  agentRecord: string;
  specHash: string;
  institution?: string;
  /** Hesabın sahibi; verilmezse escrow programı. */
  owner?: string;
}

export class JobChain {
  readonly chain = new TestChain();
  readonly client: SquareClient = createSquareClient({
    connection: this.chain.connection(),
    programIds: PROGRAM_IDS,
    commitment: 'confirmed',
  });
  private readonly jobs = new Map<string, JobFields>();

  async setJob(address: string, fields: JobFields): Promise<void> {
    this.jobs.set(address, fields);
    const program = this.client.escrow.program as unknown as Program<Idl>;
    const sample = createSampler(program.idl).struct('job') as Record<string, unknown>;
    const data = {
      ...sample,
      institution: new PublicKey(fields.institution ?? INSTITUTION),
      agentRecord: new PublicKey(fields.agentRecord),
      specHash: Array.from(Buffer.from(fields.specHash, 'hex')),
      status: { [fields.status]: {} },
      dispute: { ...(sample.dispute as object), bond: new BN(0) },
    };
    const owner = fields.owner ? new PublicKey(fields.owner) : program.programId;
    this.chain.setAccount(new PublicKey(address), owner, await program.coder.accounts.encode('job', data));
  }

  async setStatus(address: string, status: JobStatus): Promise<void> {
    const current = this.jobs.get(address);
    if (!current) throw new Error(`test zincirinde ${address} job'u yok`);
    await this.setJob(address, { ...current, status });
  }
}
