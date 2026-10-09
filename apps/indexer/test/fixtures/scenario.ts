// Test fixture: 8 adımın zincirde bıraktığı hesaplar ve tx'ler. Hesaplar senaryonun son durumundadır (RPC
// güncel durumu verir); tx'ler adım sırasıyla, her biri yazdığı hesapları yazılabilir taşır.
import { BN } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import type { World } from './world.js';

export interface Scenario {
  institution: PublicKey;
  owner: PublicKey;
  policy: PublicKey;
  agent: PublicKey;
  agentWallet: PublicKey;
  screenings: { institution: PublicKey; agent: PublicKey };
  /** Teslim edilmiş, dispute açılmış job. */
  disputedJob: PublicKey;
  /** Alacağı satılmış, ödemesi yapılmış job. */
  paidJob: PublicKey;
  claim: PublicKey;
  buyer: PublicKey;
  /** Dispute'lu job'un listelenmiş, satılmamış alacağı. */
  listedClaim: PublicKey;
  reputation: PublicKey;
  validation: PublicKey;
  releaseProof: PublicKey;
  escrowConfig: PublicKey;
  /** Başarılı tx'lerin yayımladığı event sayısı (kırpılmış logda okunabilenler dahil). */
  events: number;
  signatures: { failed: string; truncated: string; finalize: string };
}

const status = (name: string) => ({ [name]: {} });

export async function buildScenario(world: World): Promise<Scenario> {
  const k = () => world.key();
  const [institution, owner, policy, agent, agentWallet] = [k(), k(), k(), k(), k()];
  const [disputedJob, paidJob, claim, buyer, listedClaim] = [k(), k(), k(), k(), k()];
  const [reputation, validation, releaseProof, escrowConfig] = [k(), k(), k(), k()];
  const screenings = { institution: k(), agent: k() };

  await world.put(
    'policy',
    'institution',
    institution,
    world.sample('policy', 'institution', {
      ownerKey: owner,
      name: 'Example Research Ltd',
      multisig: null,
      multisigVault: null,
    }),
  );
  await world.put('policy', 'policy', policy, world.sample('policy', 'policy', { institution, active: true }));
  await world.put(
    'registry',
    'agentRecord',
    agent,
    world.sample('registry', 'agentRecord', {
      owner,
      wallet: agentWallet,
      status: status('active'),
    }),
  );
  await world.put(
    'registry',
    'screeningRecord',
    screenings.institution,
    world.sample('registry', 'screeningRecord', {
      wallet: owner,
      status: status('clear'),
      expiresAt: new BN(1_900_000_000),
    }),
  );
  await world.put(
    'registry',
    'screeningRecord',
    screenings.agent,
    world.sample('registry', 'screeningRecord', {
      wallet: agentWallet,
      status: status('flagged'),
    }),
  );
  const jobBase = { institution, agentRecord: agent, agentWallet, policy };
  const dispute = world.sample('escrow', 'disputeInfo', {
    raisedAt: new BN(1_790_000_500),
    deadline: new BN(1_790_259_700),
    decidedAt: new BN(0),
    closedAt: new BN(0),
    lapsed: false,
    approvalMask: 0b101,
    approvalCount: 2,
    arbitratorSetVersion: 3,
    resolution: status('pending'),
  });
  await world.put(
    'escrow',
    'job',
    disputedJob,
    world.sample('escrow', 'job', {
      ...jobBase,
      status: status('disputed'),
      dispute,
      disputeRejectionMask: 0b010,
    }),
  );
  const noDispute = world.sample('escrow', 'disputeInfo', { raisedAt: new BN(0), resolution: status('pending') });
  await world.put(
    'escrow',
    'job',
    paidJob,
    world.sample('escrow', 'job', {
      ...jobBase,
      status: status('released'),
      dispute: noDispute,
    }),
  );
  await world.put(
    'escrow',
    'claimListing',
    claim,
    world.sample('escrow', 'claimListing', {
      job: paidJob,
      seller: agentWallet,
      buyer,
      status: status('settled'),
    }),
  );
  await world.put(
    'escrow',
    'claimListing',
    listedClaim,
    world.sample('escrow', 'claimListing', {
      job: disputedJob,
      seller: agentWallet,
      buyer: PublicKey.default,
      status: status('listed'),
    }),
  );
  await world.put(
    'escrow',
    'agentReputation',
    reputation,
    world.sample('escrow', 'agentReputation', { agentRecord: agent }),
  );
  await world.put(
    'escrow',
    'validationRecord',
    validation,
    world.sample('escrow', 'validationRecord', {
      job: paidJob,
      agentRecord: agent,
      outcome: status('verified'),
    }),
  );
  await world.put(
    'verifier',
    'releaseProof',
    releaseProof,
    world.sample('verifier', 'releaseProof', {
      job: paidJob,
      institution,
      policy,
      payee: buyer,
      verdict: status('compliant'),
      consumed: true,
    }),
  );
  await world.put('escrow', 'escrowConfig', escrowConfig, world.sample('escrow', 'escrowConfig'));

  const ev = (program: 'registry' | 'policy' | 'verifier' | 'escrow', name: string, overrides = {}) => ({
    program,
    name,
    data: world.sample(program, name, overrides),
  });
  let events = 0;
  const tx = (spec: Parameters<World['tx']>[0]) => {
    if (!spec.err) events += spec.events?.length ?? 0;
    return world.tx(spec);
  };

  tx({
    program: 'policy',
    events: [ev('policy', 'institutionCreated', { institution, ownerKey: owner })],
    writable: [institution],
  });
  tx({
    program: 'policy',
    events: [ev('policy', 'policyCommitted', { policy, institution })],
    writable: [policy, institution],
  });
  tx({ program: 'registry', events: [ev('registry', 'agentRegistered', { agentRecord: agent })], writable: [agent] });
  tx({
    program: 'registry',
    events: [
      ev('registry', 'screeningRecorded', { wallet: owner }),
      ev('registry', 'screeningRecorded', { wallet: agentWallet }),
    ],
    writable: [screenings.institution, screenings.agent],
  });
  tx({
    program: 'escrow',
    computeBudget: true,
    events: [ev('escrow', 'jobCreated', { job: paidJob }), ev('escrow', 'jobFunded', { job: paidJob })],
    writable: [paidJob],
  });
  tx({ program: 'escrow', events: [ev('escrow', 'jobCreated', { job: disputedJob })], writable: [disputedJob] });
  tx({ program: 'escrow', events: [ev('escrow', 'claimListed', { job: paidJob })], writable: [claim, paidJob] });
  tx({ program: 'escrow', events: [ev('escrow', 'claimBought', { job: paidJob, buyer })], writable: [claim] });
  // v0 tx: ReleaseProof lookup table'dan yazılabilir yüklenir.
  tx({ program: 'verifier', events: [ev('verifier', 'complianceProofSet', { job: paidJob })], loaded: [releaseProof] });
  const finalize = tx({
    program: 'escrow',
    computeBudget: true,
    events: [
      ev('verifier', 'releaseRecorded', { job: paidJob, institution }),
      ev('escrow', 'releaseVerified', { job: paidJob, payee: buyer }),
      ev('escrow', 'reputationRecorded', { job: paidJob, agentRecord: agent }),
      ev('escrow', 'validationRecorded', { job: paidJob, agentRecord: agent }),
      ev('escrow', 'finalized', { job: paidJob }),
    ],
    writable: [paidJob, claim, reputation, validation, releaseProof],
  });
  tx({ program: 'escrow', events: [ev('escrow', 'disputeRaised', { job: disputedJob })], writable: [disputedJob] });
  tx({ program: 'escrow', events: [ev('escrow', 'claimListed', { job: disputedJob })], writable: [listedClaim] });
  // Başarısız tx: logda event olsa da durum değişmedi, event yazılmaz.
  const failed = tx({
    program: 'escrow',
    events: [ev('escrow', 'jobFunded', { job: disputedJob })],
    writable: [disputedJob],
    err: { InstructionError: [0, { Custom: 6000 }] },
  });
  // Kırpılmış log: okunabilen event yazılır, hesaplar yine okunur.
  const truncated = tx({
    program: 'escrow',
    events: [ev('escrow', 'workSubmitted', { job: disputedJob })],
    writable: [disputedJob],
    truncated: true,
  });
  // Aynalanmayan config hesabı.
  tx({ program: 'escrow', events: [ev('escrow', 'escrowConfigUpdated')], writable: [escrowConfig] });

  return {
    institution,
    owner,
    policy,
    agent,
    agentWallet,
    screenings,
    disputedJob,
    paidJob,
    claim,
    buyer,
    listedClaim,
    reputation,
    validation,
    releaseProof,
    escrowConfig,
    events,
    signatures: { failed, truncated, finalize },
  };
}
