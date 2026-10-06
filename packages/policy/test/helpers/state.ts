// Test fixture: ok_compliant senaryosunun zincir durumu (job, politika, escrow config, operator
// sayacı) program IDL'leriyle kodlanıp test zincirine konur.
import { BN, type Idl, type Program } from '@anchor-lang/core';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createSquareClient, SQUARE_IDLS, type SquareClient, type SquareProgramIds } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import { computePolicyCommitment } from '../../src/policy.js';
import { TestChain } from './chain.js';
import { scenario, testSalts, TIMESTAMP, USDC_DEVNET, world } from './circuit-world.js';
import { createSampler } from './idl-sample.js';

export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};
export const KEEPER_FEE_BPS = 200;
export const PROOF_TIMEOUT_SECS = 3600;
/** Keeper ücreti düşülünce 25 USDC kalan tutar: 25 510 204 − ⌊25 510 204 × 200 / 10 000⌋. */
export const JOB_AMOUNT = 25_510_204n;
export const salts = testSalts('default policy');
export const okPolicy: PolicyDocument = scenario({}).policy;
export const policyAccount = Keypair.generate().publicKey;
const DAY = 86_400;

const asIdl = (program: unknown) => program as Program<Idl>;

export class State {
  readonly chain = new TestChain();
  readonly client: SquareClient = createSquareClient({
    connection: this.chain.connection(),
    programIds: PROGRAM_IDS,
    commitment: 'confirmed',
  });

  async put(program: unknown, name: string, address: PublicKey, data: Record<string, unknown>) {
    const p = asIdl(program);
    this.chain.setAccount(address, p.programId, await p.coder.accounts.encode(name, data));
  }

  sample(program: unknown, type: string) {
    return createSampler(asIdl(program).idl).struct(type);
  }

  async job(overrides: Record<string, unknown> = {}) {
    const data = this.sample(this.client.escrow.program, 'job');
    await this.put(this.client.escrow.program, 'job', world.job, {
      ...data,
      institution: world.institutionWallet,
      agentWallet: world.agentWallet,
      mint: USDC_DEVNET,
      amount: new BN(JOB_AMOUNT.toString()),
      status: { delivered: {} },
      rail: { escrow: {} },
      policy: policyAccount,
      policyCommitment: Array.from(computePolicyCommitment(okPolicy, salts)),
      policyDailyCeiling: new BN(okPolicy.dailyCeiling),
      dispute: { ...(data.dispute as object), bond: new BN(0) },
      ...overrides,
    });
  }

  async policy() {
    const data = this.sample(this.client.policy.program, 'policy');
    await this.put(this.client.policy.program, 'policy', policyAccount, { ...data, institution: world.institution });
  }

  async config() {
    const data = this.sample(this.client.escrow.program, 'escrowConfig');
    const params = {
      ...(data.params as object),
      keeperFeeBps: KEEPER_FEE_BPS,
      proofTimeoutSecs: new BN(PROOF_TIMEOUT_SECS),
    };
    await this.put(this.client.escrow.program, 'escrowConfig', this.client.pda.escrowConfig()[0], { ...data, params });
  }

  async operator(dailySpent: bigint, dayStart = Math.floor(TIMESTAMP / DAY) * DAY) {
    const data = this.sample(this.client.verifier.program, 'operatorState');
    await this.put(this.client.verifier.program, 'operatorState', this.client.pda.operatorState(world.institution)[0], {
      ...data,
      institution: world.institution,
      dailySpent: new BN(dailySpent.toString()),
      dayStartUnix: new BN(dayStart),
    });
  }

  async verifierConfig(mppAuthority: PublicKey) {
    const data = this.sample(this.client.verifier.program, 'verifierConfig');
    await this.put(this.client.verifier.program, 'verifierConfig', this.client.pda.verifierConfig()[0], {
      ...data,
      mppAuthority,
    });
  }

  async claim(status: 'listed' | 'bought', buyer: PublicKey) {
    const data = this.sample(this.client.escrow.program, 'claimListing');
    await this.put(this.client.escrow.program, 'claimListing', this.client.pda.claimListing(world.job)[0], {
      ...data,
      job: world.job,
      buyer,
      status: { [status]: {} },
    });
  }

  async releaseProof(fields: Record<string, unknown>) {
    const data = this.sample(this.client.verifier.program, 'releaseProof');
    await this.put(this.client.verifier.program, 'releaseProof', this.client.pda.releaseProof(world.job)[0], {
      ...data,
      // Zincirde bağlayan kurumun PDA'sı: verifier sayacı bu kurumda tutar.
      institution: world.institution,
      ...fields,
    });
  }

  /** ok_compliant senaryosunun tamamı. */
  async ok() {
    await this.job();
    await this.policy();
    await this.config();
    await this.operator(200_000_000n);
  }
}
