// BU DOSYA ÜRETİLİR — elle değiştirmeyin. Kaynak: idl/*.json (BC-44).
// Yeniden üretim: pnpm --filter @squaresdk/solana-types gen
import { z } from 'zod';
import { Address, Hex32, I64, U64, hexBytes } from '../primitives.js';

/** registry: AgentDeregistered */
export const AgentDeregisteredSchema = z.object({
  agentRecord: Address,
});
export type AgentDeregistered = z.infer<typeof AgentDeregisteredSchema>;

/** registry: AgentOwnershipTransferred */
export const AgentOwnershipTransferredSchema = z.object({
  agentRecord: Address,
  previousOwner: Address,
  newOwner: Address,
});
export type AgentOwnershipTransferred = z.infer<typeof AgentOwnershipTransferredSchema>;

/** registry: AgentStatus */
export const AgentStatusSchema = z.enum(['active', 'inactive', 'deregistered']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** registry: seeds = ["agent", creator, agent_id] */
export const AgentRecordSchema = z.object({
  creator: Address,
  owner: Address,
  wallet: Address,
  agentCardHash: Hex32,
  status: AgentStatusSchema,
  registeredAt: I64,
  updatedAt: I64,
  bump: z.number().int().min(0).max(255),
  agentId: z.string(),
  agentCardUri: z.string(),
});
export type AgentRecord = z.infer<typeof AgentRecordSchema>;

/** registry: AgentRegistered */
export const AgentRegisteredSchema = z.object({
  agentRecord: Address,
  creator: Address,
  owner: Address,
  agentId: z.string(),
  wallet: Address,
  agentCardHash: Hex32,
});
export type AgentRegistered = z.infer<typeof AgentRegisteredSchema>;

/** escrow: seeds = ["reputation", agent_record] — bound to the registry agent, not to a wallet (BC-26). */
export const AgentReputationSchema = z.object({
  agentRecord: Address,
  jobsCompleted: U64,
  jobsFailed: U64,
  jobsDisputed: U64,
  totalEarned: U64,
  firstJobAt: I64,
  lastJobAt: I64,
  bump: z.number().int().min(0).max(255),
});
export type AgentReputation = z.infer<typeof AgentReputationSchema>;

/** registry: AgentStatusChanged */
export const AgentStatusChangedSchema = z.object({
  agentRecord: Address,
  status: AgentStatusSchema,
});
export type AgentStatusChanged = z.infer<typeof AgentStatusChangedSchema>;

/** registry: AgentUpdated */
export const AgentUpdatedSchema = z.object({
  agentRecord: Address,
  wallet: Address,
  agentCardHash: Hex32,
});
export type AgentUpdated = z.infer<typeof AgentUpdatedSchema>;

/** escrow: ArbitratorsUpdated */
export const ArbitratorsUpdatedSchema = z.object({
  arbitrators: z.array(Address),
  threshold: z.number().int().min(0).max(255),
  arbitratorSetVersion: z.number().int().min(0).max(4294967295),
});
export type ArbitratorsUpdated = z.infer<typeof ArbitratorsUpdatedSchema>;

/** policy: BuyerRootCommitted */
export const BuyerRootCommittedSchema = z.object({
  policy: Address,
  buyerRoot: Hex32,
});
export type BuyerRootCommitted = z.infer<typeof BuyerRootCommittedSchema>;

/** escrow: ClaimBought */
export const ClaimBoughtSchema = z.object({
  job: Address,
  buyer: Address,
  price: U64,
});
export type ClaimBought = z.infer<typeof ClaimBoughtSchema>;

/** escrow: ClaimCancelled */
export const ClaimCancelledSchema = z.object({
  job: Address,
});
export type ClaimCancelled = z.infer<typeof ClaimCancelledSchema>;

/** escrow: ClaimListed */
export const ClaimListedSchema = z.object({
  job: Address,
  seller: Address,
  price: U64,
  faceValue: U64,
});
export type ClaimListed = z.infer<typeof ClaimListedSchema>;

/** escrow: `cancel_claim` closes the listing, so there is no Cancelled state. */
export const ClaimStatusSchema = z.enum(['listed', 'bought', 'settled', 'defaulted']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

/** escrow: seeds = ["claim", job] */
export const ClaimListingSchema = z.object({
  job: Address,
  seller: Address,
  buyer: Address,
  rentPayer: Address,
  price: U64,
  faceValue: U64,
  listedAt: I64,
  boughtAt: I64,
  status: ClaimStatusSchema,
  bump: z.number().int().min(0).max(255),
});
export type ClaimListing = z.infer<typeof ClaimListingSchema>;

/** verifier: ReleaseVerdict */
export const ReleaseVerdictSchema = z.enum(['compliant', 'refused']);
export type ReleaseVerdict = z.infer<typeof ReleaseVerdictSchema>;

/** verifier: ComplianceProofSet */
export const ComplianceProofSetSchema = z.object({
  job: Address,
  policy: Address,
  verdict: ReleaseVerdictSchema,
  refusalCode: z.number().int().min(0).max(65535),
  payee: Address,
  netAmount: U64,
  mint: Address,
  dailySpentBefore: U64,
});
export type ComplianceProofSet = z.infer<typeof ComplianceProofSetSchema>;

/** escrow: DisputeResolution */
export const DisputeResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('favorAgent') }),
  z.object({ kind: z.literal('favorInstitution') }),
  z.object({ kind: z.literal('split'), agentAmount: U64 }),
]);
export type DisputeResolution = z.infer<typeof DisputeResolutionSchema>;

/** escrow: DisputeDecided */
export const DisputeDecidedSchema = z.object({
  job: Address,
  resolution: DisputeResolutionSchema,
});
export type DisputeDecided = z.infer<typeof DisputeDecidedSchema>;

/** escrow: Inline dispute state; `raised_at == 0` means no dispute. One dispute per job. */
export const DisputeInfoSchema = z.object({
  challenger: Address,
  bond: U64,
  reasonHash: Hex32,
  raisedAt: I64,
  deadline: I64,
  decidedAt: I64,
  closedAt: I64,
  lapsed: z.boolean(),
  approvalMask: z.number().int().min(0).max(255),
  approvalCount: z.number().int().min(0).max(255),
  arbitratorSetVersion: z.number().int().min(0).max(4294967295),
  resolution: DisputeResolutionSchema,
});
export type DisputeInfo = z.infer<typeof DisputeInfoSchema>;

/** escrow: DRAFT (M5). */
export const DisputeLapsedSchema = z.object({
  job: Address,
  bondRefunded: U64,
});
export type DisputeLapsed = z.infer<typeof DisputeLapsedSchema>;

/** escrow: DisputeRaised */
export const DisputeRaisedSchema = z.object({
  job: Address,
  challenger: Address,
  bond: U64,
  reasonHash: Hex32,
  deadline: I64,
});
export type DisputeRaised = z.infer<typeof DisputeRaisedSchema>;

/** escrow: DisputeResolved */
export const DisputeResolvedSchema = z.object({
  job: Address,
  resolution: DisputeResolutionSchema,
  agentSideAmount: U64,
  institutionRefund: U64,
  bondToAgentSide: U64,
  bondReturned: U64,
});
export type DisputeResolved = z.infer<typeof DisputeResolvedSchema>;

/** escrow: DisputeVote */
export const DisputeVoteSchema = z.object({
  job: Address,
  arbitrator: Address,
  resolution: DisputeResolutionSchema,
  approvalCount: z.number().int().min(0).max(255),
});
export type DisputeVote = z.infer<typeof DisputeVoteSchema>;

/** escrow: EscrowParams */
export const EscrowParamsSchema = z.object({
  minChallengePeriod: U64,
  maxChallengePeriod: U64,
  minBondBps: z.number().int().min(0).max(65535),
  minBondAbsolute: U64,
  keeperFeeBps: z.number().int().min(0).max(65535),
  proofTimeoutSecs: I64,
  disputeTimeoutSecs: I64,
  travelRuleThreshold: U64,
});
export type EscrowParams = z.infer<typeof EscrowParamsSchema>;

/** escrow: Singleton. seeds = ["config"] */
export const EscrowConfigSchema = z.object({
  admin: Address,
  settlementMint: Address,
  registryProgram: Address,
  policyProgram: Address,
  verifierProgram: Address,
  arbitrators: z.array(Address).length(7),
  arbitratorCount: z.number().int().min(0).max(255),
  threshold: z.number().int().min(0).max(255),
  arbitratorSetVersion: z.number().int().min(0).max(4294967295),
  params: EscrowParamsSchema,
  bump: z.number().int().min(0).max(255),
});
export type EscrowConfig = z.infer<typeof EscrowConfigSchema>;

/** escrow: EscrowConfigUpdated */
export const EscrowConfigUpdatedSchema = z.object({
  admin: Address,
  settlementMint: Address,
  params: EscrowParamsSchema,
});
export type EscrowConfigUpdated = z.infer<typeof EscrowConfigUpdatedSchema>;

/** escrow: Finalized */
export const FinalizedSchema = z.object({
  job: Address,
  keeper: Address,
  keeperFee: U64,
});
export type Finalized = z.infer<typeof FinalizedSchema>;

/** policy: seeds = ["institution", owner_key] */
export const InstitutionSchema = z.object({
  ownerKey: Address,
  policyCount: z.number().int().min(0).max(4294967295),
  createdAt: I64,
  bump: z.number().int().min(0).max(255),
  name: z.string(),
  multisig: Address.nullable(),
  multisigVault: Address.nullable(),
});
export type Institution = z.infer<typeof InstitutionSchema>;

/** policy: InstitutionCreated */
export const InstitutionCreatedSchema = z.object({
  institution: Address,
  ownerKey: Address,
  name: z.string(),
});
export type InstitutionCreated = z.infer<typeof InstitutionCreatedSchema>;

/** policy: InstitutionMultisigSet */
export const InstitutionMultisigSetSchema = z.object({
  institution: Address,
  multisig: Address,
  multisigVault: Address,
});
export type InstitutionMultisigSet = z.infer<typeof InstitutionMultisigSetSchema>;

/** escrow: JobStatus */
export const JobStatusSchema = z.enum(['open', 'funded', 'accepted', 'delivered', 'disputed', 'resolved', 'released', 'refunded', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** escrow: seeds = ["job", institution, spec_hash]; vault = ["escrow_token", job], bond vault = ["bond", job] (token authority of both = job). */
export const JobSchema = z.object({
  institution: Address,
  agentRecord: Address,
  agentWallet: Address,
  mint: Address,
  rentPayer: Address,
  amount: U64,
  specHash: Hex32,
  status: JobStatusSchema,
  createdAt: I64,
  fundedAt: I64,
  deadline: I64,
  challengePeriod: U64,
  challengeEnd: I64,
  deliveredAt: I64,
  settledAt: I64,
  workHash: Hex32,
  travelRuleCommitment: Hex32,
  policyCommitment: Hex32,
  policyDailyCeiling: U64,
  policyVersion: z.number().int().min(0).max(4294967295),
  bump: z.number().int().min(0).max(255),
  vaultBump: z.number().int().min(0).max(255),
  bondBump: z.number().int().min(0).max(255),
  policy: Address.nullable(),
  dispute: DisputeInfoSchema,
  deliveryUri: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

/** escrow: JobAccepted */
export const JobAcceptedSchema = z.object({
  job: Address,
  agentRecord: Address,
  agentWallet: Address,
});
export type JobAccepted = z.infer<typeof JobAcceptedSchema>;

/** escrow: JobAgentWalletSynced */
export const JobAgentWalletSyncedSchema = z.object({
  job: Address,
  agentWallet: Address,
});
export type JobAgentWalletSynced = z.infer<typeof JobAgentWalletSyncedSchema>;

/** escrow: JobCancelled */
export const JobCancelledSchema = z.object({
  job: Address,
  refundedAmount: U64,
});
export type JobCancelled = z.infer<typeof JobCancelledSchema>;

/** escrow: JobCreated */
export const JobCreatedSchema = z.object({
  job: Address,
  institution: Address,
  agentRecord: Address,
  agentWallet: Address,
  policy: Address.nullable(),
  policyVersion: z.number().int().min(0).max(4294967295),
  mint: Address,
  amount: U64,
  specHash: Hex32,
  deadline: I64,
  challengePeriod: U64,
});
export type JobCreated = z.infer<typeof JobCreatedSchema>;

/** escrow: JobFunded */
export const JobFundedSchema = z.object({
  job: Address,
  amount: U64,
});
export type JobFunded = z.infer<typeof JobFundedSchema>;

/** escrow: LinkedPrograms */
export const LinkedProgramsSchema = z.object({
  registryProgram: Address,
  policyProgram: Address,
  verifierProgram: Address,
});
export type LinkedPrograms = z.infer<typeof LinkedProgramsSchema>;

/** escrow: DRAFT (M5). */
export const MissingProofEscalatedSchema = z.object({
  job: Address,
  agentWallet: Address,
});
export type MissingProofEscalated = z.infer<typeof MissingProofEscalatedSchema>;

/** verifier: DRAFT (M6). */
export const MppPaymentVerifiedSchema = z.object({
  institution: Address,
  policy: Address,
  stripeReceiptHash: Hex32,
  amount: U64,
});
export type MppPaymentVerified = z.infer<typeof MppPaymentVerifiedSchema>;

/** verifier: seeds = ["operator_state", institution] (institution = square_policy `Institution` PDA) */
export const OperatorStateSchema = z.object({
  institution: Address,
  dailySpent: U64,
  dayStartUnix: I64,
  totalLifetimePayments: U64,
  bump: z.number().int().min(0).max(255),
});
export type OperatorState = z.infer<typeof OperatorStateSchema>;

/** policy: seeds = ["policy", institution, policy_id] */
export const PolicySchema = z.object({
  institution: Address,
  policyId: Hex32,
  commitment: Hex32,
  dailyCeiling: U64,
  buyerRoot: Hex32,
  version: z.number().int().min(0).max(4294967295),
  active: z.boolean(),
  createdAt: I64,
  updatedAt: I64,
  bump: z.number().int().min(0).max(255),
});
export type Policy = z.infer<typeof PolicySchema>;

/** policy: PolicyCommitted */
export const PolicyCommittedSchema = z.object({
  policy: Address,
  institution: Address,
  policyId: Hex32,
  commitment: Hex32,
  dailyCeiling: U64,
  version: z.number().int().min(0).max(4294967295),
});
export type PolicyCommitted = z.infer<typeof PolicyCommittedSchema>;

/** policy: PolicyDeactivated */
export const PolicyDeactivatedSchema = z.object({
  policy: Address,
});
export type PolicyDeactivated = z.infer<typeof PolicyDeactivatedSchema>;

/** policy: PolicyUpdated */
export const PolicyUpdatedSchema = z.object({
  policy: Address,
  commitment: Hex32,
  dailyCeiling: U64,
  version: z.number().int().min(0).max(4294967295),
});
export type PolicyUpdated = z.infer<typeof PolicyUpdatedSchema>;

/** registry: Singleton. seeds = ["registry_config"] */
export const RegistryConfigSchema = z.object({
  admin: Address,
  screenerAuthority: Address,
  screeningTtlSecs: I64,
  bump: z.number().int().min(0).max(255),
});
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

/** registry: RegistryConfigUpdated */
export const RegistryConfigUpdatedSchema = z.object({
  admin: Address,
  screenerAuthority: Address,
  screeningTtlSecs: I64,
});
export type RegistryConfigUpdated = z.infer<typeof RegistryConfigUpdatedSchema>;

/** verifier: seeds = ["release_proof", job] */
export const ReleaseProofSchema = z.object({
  job: Address,
  institution: Address,
  policy: Address,
  payee: Address,
  netAmount: U64,
  mint: Address,
  dailySpentBefore: U64,
  proofTimestamp: I64,
  verdict: ReleaseVerdictSchema,
  refusalCode: z.number().int().min(0).max(65535),
  consumed: z.boolean(),
  bump: z.number().int().min(0).max(255),
});
export type ReleaseProof = z.infer<typeof ReleaseProofSchema>;

/** verifier: ReleaseRecorded */
export const ReleaseRecordedSchema = z.object({
  job: Address,
  institution: Address,
  netAmount: U64,
  dailySpent: U64,
  dayStartUnix: I64,
});
export type ReleaseRecorded = z.infer<typeof ReleaseRecordedSchema>;

/** escrow: ReleaseRefused */
export const ReleaseRefusedSchema = z.object({
  job: Address,
  refusalCode: z.number().int().min(0).max(65535),
  refundedAmount: U64,
  releaseProof: Address,
});
export type ReleaseRefused = z.infer<typeof ReleaseRefusedSchema>;

/** escrow: ReleaseVerified */
export const ReleaseVerifiedSchema = z.object({
  job: Address,
  payee: Address,
  netAmount: U64,
  releaseProof: Address.nullable(),
});
export type ReleaseVerified = z.infer<typeof ReleaseVerifiedSchema>;

/** escrow: ReputationRecorded */
export const ReputationRecordedSchema = z.object({
  agentRecord: Address,
  job: Address,
  jobsCompleted: U64,
  jobsFailed: U64,
  jobsDisputed: U64,
  totalEarned: U64,
});
export type ReputationRecorded = z.infer<typeof ReputationRecordedSchema>;

/** registry: ScreeningStatus */
export const ScreeningStatusSchema = z.enum(['clear', 'flagged']);
export type ScreeningStatus = z.infer<typeof ScreeningStatusSchema>;

/** registry: seeds = ["screening", wallet] */
export const ScreeningRecordSchema = z.object({
  wallet: Address,
  status: ScreeningStatusSchema,
  sourceHash: Hex32,
  screenedAt: I64,
  expiresAt: I64,
  bump: z.number().int().min(0).max(255),
});
export type ScreeningRecord = z.infer<typeof ScreeningRecordSchema>;

/** registry: ScreeningRecorded */
export const ScreeningRecordedSchema = z.object({
  wallet: Address,
  status: ScreeningStatusSchema,
  sourceHash: Hex32,
  expiresAt: I64,
});
export type ScreeningRecorded = z.infer<typeof ScreeningRecordedSchema>;

/** escrow: A Travel Rule commitment was bound to an Open job (BC-34). */
export const TravelRuleCommittedSchema = z.object({
  job: Address,
  commitment: Hex32,
});
export type TravelRuleCommitted = z.infer<typeof TravelRuleCommittedSchema>;

/** escrow: ValidationOutcome */
export const ValidationOutcomeSchema = z.enum(['verified', 'refused', 'noGate', 'noPayout']);
export type ValidationOutcome = z.infer<typeof ValidationOutcomeSchema>;

/** escrow: seeds = ["validation", job] — gate outcome of a settled job (BC-26); written once per job. */
export const ValidationRecordSchema = z.object({
  job: Address,
  agentRecord: Address,
  outcome: ValidationOutcomeSchema,
  refusalCode: z.number().int().min(0).max(65535),
  recordedAt: I64,
  bump: z.number().int().min(0).max(255),
  policy: Address.nullable(),
  releaseProof: Address.nullable(),
});
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

/** escrow: ValidationRecorded */
export const ValidationRecordedSchema = z.object({
  job: Address,
  agentRecord: Address,
  outcome: ValidationOutcomeSchema,
  refusalCode: z.number().int().min(0).max(65535),
});
export type ValidationRecorded = z.infer<typeof ValidationRecordedSchema>;

/** verifier: Singleton. seeds = ["verifier_config"] */
export const VerifierConfigSchema = z.object({
  admin: Address,
  escrowProgram: Address,
  policyProgram: Address,
  mppAuthority: Address,
  vkVersion: z.number().int().min(0).max(65535),
  bump: z.number().int().min(0).max(255),
});
export type VerifierConfig = z.infer<typeof VerifierConfigSchema>;

/** verifier: VerifierConfigUpdated */
export const VerifierConfigUpdatedSchema = z.object({
  admin: Address,
  escrowProgram: Address,
  policyProgram: Address,
  mppAuthority: Address,
  vkVersion: z.number().int().min(0).max(65535),
});
export type VerifierConfigUpdated = z.infer<typeof VerifierConfigUpdatedSchema>;

/** escrow: WorkSubmitted */
export const WorkSubmittedSchema = z.object({
  job: Address,
  workHash: Hex32,
  deliveryUri: z.string(),
  challengeEnd: I64,
});
export type WorkSubmitted = z.infer<typeof WorkSubmittedSchema>;

/** IDL özeti: program adresleri (geçici, BC-09), hesap / event / instruction adları ve hata kodları. */
export const IDL_PROGRAMS = {
  "registry": {
    "address": "AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9",
    "name": "square_registry_contract",
    "version": "0.1.0",
    "accounts": [
      "AgentRecord",
      "RegistryConfig",
      "ScreeningRecord"
    ],
    "events": [
      "AgentDeregistered",
      "AgentOwnershipTransferred",
      "AgentRegistered",
      "AgentStatusChanged",
      "AgentUpdated",
      "RegistryConfigUpdated",
      "ScreeningRecorded"
    ],
    "instructions": [
      "deregister_agent",
      "init_registry_config",
      "record_screening",
      "register_agent",
      "set_agent_status",
      "transfer_agent_ownership",
      "update_agent",
      "update_registry_config"
    ],
    "errors": [
      {
        "code": 6000,
        "name": "AgentIdInvalid",
        "msg": "Agent ID must be 1-32 characters from [A-Za-z0-9_-]"
      },
      {
        "code": 6001,
        "name": "AgentCardUriTooLong",
        "msg": "Agent card URI exceeds 200 bytes"
      },
      {
        "code": 6002,
        "name": "Unauthorized",
        "msg": "Signer is not authorized for this operation"
      },
      {
        "code": 6003,
        "name": "AgentInactive",
        "msg": "Agent is not active"
      },
      {
        "code": 6004,
        "name": "AgentDeregistered",
        "msg": "Agent is deregistered"
      },
      {
        "code": 6005,
        "name": "InvalidAgentStatus",
        "msg": "Status cannot be set with this instruction"
      },
      {
        "code": 6006,
        "name": "InvalidScreeningTtl",
        "msg": "Screening TTL must be positive"
      },
      {
        "code": 6007,
        "name": "AgentCardHashInvalid",
        "msg": "Agent card hash must be all zero exactly when the agent card URI is empty"
      }
    ]
  },
  "policy": {
    "address": "63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4",
    "name": "square_policy_contract",
    "version": "0.1.0",
    "accounts": [
      "Institution",
      "Policy"
    ],
    "events": [
      "BuyerRootCommitted",
      "InstitutionCreated",
      "InstitutionMultisigSet",
      "PolicyCommitted",
      "PolicyDeactivated",
      "PolicyUpdated"
    ],
    "instructions": [
      "deactivate_policy",
      "init_institution",
      "set_buyer_root",
      "set_institution_multisig",
      "set_policy",
      "update_policy"
    ],
    "errors": [
      {
        "code": 6000,
        "name": "Unauthorized",
        "msg": "Signer is not the institution's current authority"
      },
      {
        "code": 6001,
        "name": "NameTooLong",
        "msg": "Institution name exceeds 64 bytes"
      },
      {
        "code": 6002,
        "name": "PolicyInactive",
        "msg": "Policy is not active"
      },
      {
        "code": 6003,
        "name": "InvalidDailyCeiling",
        "msg": "Daily ceiling must be greater than zero"
      },
      {
        "code": 6004,
        "name": "InvalidSquadsMultisig",
        "msg": "Account is not an initialized Squads v4 multisig"
      }
    ]
  },
  "verifier": {
    "address": "8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh",
    "name": "square_verifier_contract",
    "version": "0.1.0",
    "accounts": [
      "OperatorState",
      "ReleaseProof",
      "VerifierConfig"
    ],
    "events": [
      "ComplianceProofSet",
      "MppPaymentVerified",
      "ReleaseRecorded",
      "VerifierConfigUpdated"
    ],
    "instructions": [
      "init_verifier_config",
      "record_release",
      "set_compliance_proof",
      "sync_vk_version",
      "update_mpp_authority",
      "verify_mpp_payment_proof"
    ],
    "errors": [
      {
        "code": 6000,
        "name": "InvalidProof",
        "msg": "Groth16 proof verification failed"
      },
      {
        "code": 6001,
        "name": "PolicyMismatch",
        "msg": "Job has no policy or references a different policy"
      },
      {
        "code": 6002,
        "name": "SnapshotMismatch",
        "msg": "Proof commitment or ceiling does not match the job's policy snapshot"
      },
      {
        "code": 6003,
        "name": "PayeeMismatch",
        "msg": "Proof payee does not match the address the escrow will pay"
      },
      {
        "code": 6004,
        "name": "MintMismatch",
        "msg": "Proof mint does not match the job mint"
      },
      {
        "code": 6005,
        "name": "StaleProof",
        "msg": "Proof was built against an outdated daily counter or clock"
      },
      {
        "code": 6006,
        "name": "ProofAlreadyConsumed",
        "msg": "Release proof already consumed"
      },
      {
        "code": 6007,
        "name": "Unauthorized",
        "msg": "Signer is not authorized for this operation"
      },
      {
        "code": 6008,
        "name": "InvalidLinkedAccount",
        "msg": "Account owner or seeds do not match the linked program"
      },
      {
        "code": 6009,
        "name": "InvalidJobState",
        "msg": "Job is not in a state that accepts a release proof"
      },
      {
        "code": 6010,
        "name": "InvalidMppAttestation",
        "msg": "MPP attestation missing or signed by an unexpected key"
      },
      {
        "code": 6011,
        "name": "VkVersionAlreadySynced",
        "msg": "Config already records the embedded verifying key version"
      }
    ]
  },
  "escrow": {
    "address": "6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX",
    "name": "square_escrow_contract",
    "version": "0.1.0",
    "accounts": [
      "AgentReputation",
      "ClaimListing",
      "EscrowConfig",
      "Job",
      "ValidationRecord"
    ],
    "events": [
      "ArbitratorsUpdated",
      "ClaimBought",
      "ClaimCancelled",
      "ClaimListed",
      "DisputeDecided",
      "DisputeLapsed",
      "DisputeRaised",
      "DisputeResolved",
      "DisputeVote",
      "EscrowConfigUpdated",
      "Finalized",
      "JobAccepted",
      "JobAgentWalletSynced",
      "JobCancelled",
      "JobCreated",
      "JobFunded",
      "MissingProofEscalated",
      "ReleaseRefused",
      "ReleaseVerified",
      "ReputationRecorded",
      "TravelRuleCommitted",
      "ValidationRecorded",
      "WorkSubmitted"
    ],
    "instructions": [
      "accept_job",
      "buy_claim",
      "cancel_claim",
      "cancel_job",
      "commit_travel_rule",
      "create_job",
      "escalate_missing_proof",
      "execute_resolution",
      "finalize_payment",
      "fund_job",
      "init_config",
      "lapse_dispute",
      "list_claim",
      "raise_dispute",
      "resolve_dispute",
      "submit_work",
      "sync_agent_wallet",
      "update_arbitrators",
      "update_params"
    ],
    "errors": [
      {
        "code": 6000,
        "name": "InvalidStatus",
        "msg": "Job is not in the required status for this operation"
      },
      {
        "code": 6001,
        "name": "DeadlineExpired",
        "msg": "Job deadline has passed"
      },
      {
        "code": 6002,
        "name": "DeadlineNotExpired",
        "msg": "Job deadline has not passed yet"
      },
      {
        "code": 6003,
        "name": "SpecHashMismatch",
        "msg": "Spec hash provided does not match committed hash"
      },
      {
        "code": 6004,
        "name": "Unauthorized",
        "msg": "Signer is not authorized for this operation"
      },
      {
        "code": 6005,
        "name": "InvalidAmount",
        "msg": "Payment amount must be greater than zero"
      },
      {
        "code": 6006,
        "name": "InvalidChallengePeriod",
        "msg": "Challenge period must be within protocol min/max bounds"
      },
      {
        "code": 6007,
        "name": "DeliveryUriTooLong",
        "msg": "Delivery URI exceeds maximum length"
      },
      {
        "code": 6008,
        "name": "ChallengePeriodNotExpired",
        "msg": "Challenge period has not expired yet"
      },
      {
        "code": 6009,
        "name": "MintMismatch",
        "msg": "Token mint is not the settlement mint or the job mint"
      },
      {
        "code": 6010,
        "name": "MathOverflow",
        "msg": "Math overflow"
      },
      {
        "code": 6011,
        "name": "JobNotFunded",
        "msg": "Job is not funded"
      },
      {
        "code": 6012,
        "name": "AgentNotRegistered",
        "msg": "Agent record is not a registered square_registry account"
      },
      {
        "code": 6013,
        "name": "AgentInactive",
        "msg": "Agent record is not active"
      },
      {
        "code": 6014,
        "name": "AgentMismatch",
        "msg": "Signer does not match the job's agent wallet"
      },
      {
        "code": 6015,
        "name": "ScreeningRequired",
        "msg": "Screening record missing or not owned by square_registry"
      },
      {
        "code": 6016,
        "name": "ScreeningExpired",
        "msg": "Screening record has expired"
      },
      {
        "code": 6017,
        "name": "ScreeningFlagged",
        "msg": "Wallet is flagged by sanctions screening"
      },
      {
        "code": 6018,
        "name": "DisputeWindowClosed",
        "msg": "Challenge window has already closed"
      },
      {
        "code": 6019,
        "name": "DisputeAlreadyActive",
        "msg": "Dispute is already active on this job"
      },
      {
        "code": 6020,
        "name": "DisputeAlreadyRaised",
        "msg": "This job already had a dispute"
      },
      {
        "code": 6021,
        "name": "NoActiveDispute",
        "msg": "No active dispute on this job"
      },
      {
        "code": 6022,
        "name": "InsufficientBond",
        "msg": "Insufficient dispute bond provided"
      },
      {
        "code": 6023,
        "name": "NotArbitrator",
        "msg": "Signer is not an active arbitrator"
      },
      {
        "code": 6024,
        "name": "AlreadyVoted",
        "msg": "Arbitrator has already voted on this dispute"
      },
      {
        "code": 6025,
        "name": "ResolutionMismatch",
        "msg": "Vote does not match the pending resolution"
      },
      {
        "code": 6026,
        "name": "ResolutionNotDecided",
        "msg": "Dispute has not reached the arbitrator threshold"
      },
      {
        "code": 6027,
        "name": "InvalidSplitAmount",
        "msg": "Split amount exceeds the escrowed amount"
      },
      {
        "code": 6028,
        "name": "InvalidThreshold",
        "msg": "Threshold must satisfy 2 <= M <= N"
      },
      {
        "code": 6029,
        "name": "InvalidArbitratorSet",
        "msg": "Arbitrator set exceeds MAX_ARBITRATORS or contains duplicates"
      },
      {
        "code": 6030,
        "name": "DisputeNotExpired",
        "msg": "Dispute deadline has not passed yet"
      },
      {
        "code": 6031,
        "name": "InvalidClaimPrice",
        "msg": "Claim price must be greater than zero and less than the face value"
      },
      {
        "code": 6032,
        "name": "InvalidClaimStatus",
        "msg": "Claim listing is not in the required status for this operation"
      },
      {
        "code": 6033,
        "name": "ClaimListingMismatch",
        "msg": "Claim listing references a different job"
      },
      {
        "code": 6034,
        "name": "ClaimListingRequired",
        "msg": "A bought claim exists; payment must route to the buyer"
      },
      {
        "code": 6035,
        "name": "NotClaimSeller",
        "msg": "Only the seller may cancel this listing"
      },
      {
        "code": 6036,
        "name": "BuyerIsSeller",
        "msg": "Buyer may not be the seller"
      },
      {
        "code": 6037,
        "name": "BuyerNotEligible",
        "msg": "Buyer is not in the institution's approved buyer set"
      },
      {
        "code": 6038,
        "name": "ClaimPriceChanged",
        "msg": "Listing price differs from the expected price"
      },
      {
        "code": 6039,
        "name": "ProofRequired",
        "msg": "Policy job: a release proof must be bound before release"
      },
      {
        "code": 6040,
        "name": "InvalidReleaseProof",
        "msg": "Release proof has the wrong owner, seeds or job"
      },
      {
        "code": 6041,
        "name": "StaleReleaseProof",
        "msg": "Release proof is stale (payee, net amount, mint or daily counter changed)"
      },
      {
        "code": 6042,
        "name": "PolicyMismatch",
        "msg": "Policy account does not match the job policy"
      },
      {
        "code": 6043,
        "name": "PolicyInactive",
        "msg": "Policy is not active"
      },
      {
        "code": 6044,
        "name": "InvalidKeeperFee",
        "msg": "Keeper fee exceeds the allowed maximum"
      },
      {
        "code": 6045,
        "name": "LinkedProgramMismatch",
        "msg": "Account owner does not match the linked program in the config"
      },
      {
        "code": 6046,
        "name": "ProofTimeoutNotReached",
        "msg": "Proof timeout has not passed yet"
      },
      {
        "code": 6047,
        "name": "TravelRuleCommitmentRequired",
        "msg": "Travel Rule commitment required above the threshold"
      }
    ]
  }
} as const;
export type SquareProgram = keyof typeof IDL_PROGRAMS;

/** Zincirden çözülen event: program + event adı + payload (indexer ve API bu biçimi kullanır). */
export const ProgramEventPayloadSchema = z.discriminatedUnion('name', [
  z.object({ program: z.literal('registry'), name: z.literal('AgentDeregistered'), data: AgentDeregisteredSchema }),
  z.object({ program: z.literal('registry'), name: z.literal('AgentOwnershipTransferred'), data: AgentOwnershipTransferredSchema }),
  z.object({ program: z.literal('registry'), name: z.literal('AgentRegistered'), data: AgentRegisteredSchema }),
  z.object({ program: z.literal('registry'), name: z.literal('AgentStatusChanged'), data: AgentStatusChangedSchema }),
  z.object({ program: z.literal('registry'), name: z.literal('AgentUpdated'), data: AgentUpdatedSchema }),
  z.object({ program: z.literal('registry'), name: z.literal('RegistryConfigUpdated'), data: RegistryConfigUpdatedSchema }),
  z.object({ program: z.literal('registry'), name: z.literal('ScreeningRecorded'), data: ScreeningRecordedSchema }),
  z.object({ program: z.literal('policy'), name: z.literal('BuyerRootCommitted'), data: BuyerRootCommittedSchema }),
  z.object({ program: z.literal('policy'), name: z.literal('InstitutionCreated'), data: InstitutionCreatedSchema }),
  z.object({ program: z.literal('policy'), name: z.literal('InstitutionMultisigSet'), data: InstitutionMultisigSetSchema }),
  z.object({ program: z.literal('policy'), name: z.literal('PolicyCommitted'), data: PolicyCommittedSchema }),
  z.object({ program: z.literal('policy'), name: z.literal('PolicyDeactivated'), data: PolicyDeactivatedSchema }),
  z.object({ program: z.literal('policy'), name: z.literal('PolicyUpdated'), data: PolicyUpdatedSchema }),
  z.object({ program: z.literal('verifier'), name: z.literal('ComplianceProofSet'), data: ComplianceProofSetSchema }),
  z.object({ program: z.literal('verifier'), name: z.literal('MppPaymentVerified'), data: MppPaymentVerifiedSchema }),
  z.object({ program: z.literal('verifier'), name: z.literal('ReleaseRecorded'), data: ReleaseRecordedSchema }),
  z.object({ program: z.literal('verifier'), name: z.literal('VerifierConfigUpdated'), data: VerifierConfigUpdatedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ArbitratorsUpdated'), data: ArbitratorsUpdatedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ClaimBought'), data: ClaimBoughtSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ClaimCancelled'), data: ClaimCancelledSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ClaimListed'), data: ClaimListedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('DisputeDecided'), data: DisputeDecidedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('DisputeLapsed'), data: DisputeLapsedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('DisputeRaised'), data: DisputeRaisedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('DisputeResolved'), data: DisputeResolvedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('DisputeVote'), data: DisputeVoteSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('EscrowConfigUpdated'), data: EscrowConfigUpdatedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('Finalized'), data: FinalizedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('JobAccepted'), data: JobAcceptedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('JobAgentWalletSynced'), data: JobAgentWalletSyncedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('JobCancelled'), data: JobCancelledSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('JobCreated'), data: JobCreatedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('JobFunded'), data: JobFundedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('MissingProofEscalated'), data: MissingProofEscalatedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ReleaseRefused'), data: ReleaseRefusedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ReleaseVerified'), data: ReleaseVerifiedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ReputationRecorded'), data: ReputationRecordedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('TravelRuleCommitted'), data: TravelRuleCommittedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('ValidationRecorded'), data: ValidationRecordedSchema }),
  z.object({ program: z.literal('escrow'), name: z.literal('WorkSubmitted'), data: WorkSubmittedSchema }),
]);
export type ProgramEventPayload = z.infer<typeof ProgramEventPayloadSchema>;

/** registry.deregister_agent argümanları. */
export const DeregisterAgentArgsSchema = z.object({});
export type DeregisterAgentArgs = z.infer<typeof DeregisterAgentArgsSchema>;

/** registry.init_registry_config argümanları. */
export const InitRegistryConfigArgsSchema = z.object({
  screenerAuthority: Address,
  screeningTtlSecs: I64,
});
export type InitRegistryConfigArgs = z.infer<typeof InitRegistryConfigArgsSchema>;

/** registry.record_screening argümanları. */
export const RecordScreeningArgsSchema = z.object({
  wallet: Address,
  status: ScreeningStatusSchema,
  sourceHash: Hex32,
});
export type RecordScreeningArgs = z.infer<typeof RecordScreeningArgsSchema>;

/** registry.register_agent argümanları. */
export const RegisterAgentArgsSchema = z.object({
  agentId: z.string(),
  agentCardUri: z.string(),
  agentCardHash: Hex32,
  wallet: Address,
});
export type RegisterAgentArgs = z.infer<typeof RegisterAgentArgsSchema>;

/** registry.set_agent_status argümanları. */
export const SetAgentStatusArgsSchema = z.object({
  status: AgentStatusSchema,
});
export type SetAgentStatusArgs = z.infer<typeof SetAgentStatusArgsSchema>;

/** registry.transfer_agent_ownership argümanları. */
export const TransferAgentOwnershipArgsSchema = z.object({
  newOwner: Address,
});
export type TransferAgentOwnershipArgs = z.infer<typeof TransferAgentOwnershipArgsSchema>;

/** registry.update_agent argümanları. */
export const UpdateAgentArgsSchema = z.object({
  agentCardUri: z.string(),
  agentCardHash: Hex32,
  wallet: Address,
});
export type UpdateAgentArgs = z.infer<typeof UpdateAgentArgsSchema>;

/** registry.update_registry_config argümanları. */
export const UpdateRegistryConfigArgsSchema = z.object({
  screenerAuthority: Address,
  screeningTtlSecs: I64,
});
export type UpdateRegistryConfigArgs = z.infer<typeof UpdateRegistryConfigArgsSchema>;

/** policy.deactivate_policy argümanları. */
export const DeactivatePolicyArgsSchema = z.object({});
export type DeactivatePolicyArgs = z.infer<typeof DeactivatePolicyArgsSchema>;

/** policy.init_institution argümanları. */
export const InitInstitutionArgsSchema = z.object({
  name: z.string(),
});
export type InitInstitutionArgs = z.infer<typeof InitInstitutionArgsSchema>;

/** policy.set_buyer_root argümanları. */
export const SetBuyerRootArgsSchema = z.object({
  buyerRoot: Hex32,
});
export type SetBuyerRootArgs = z.infer<typeof SetBuyerRootArgsSchema>;

/** policy.set_institution_multisig argümanları. */
export const SetInstitutionMultisigArgsSchema = z.object({
  multisig: Address,
  vaultIndex: z.number().int().min(0).max(255),
});
export type SetInstitutionMultisigArgs = z.infer<typeof SetInstitutionMultisigArgsSchema>;

/** policy.set_policy argümanları. */
export const SetPolicyArgsSchema = z.object({
  policyId: Hex32,
  commitment: Hex32,
  dailyCeiling: U64,
});
export type SetPolicyArgs = z.infer<typeof SetPolicyArgsSchema>;

/** policy.update_policy argümanları. */
export const UpdatePolicyArgsSchema = z.object({
  commitment: Hex32,
  dailyCeiling: U64,
});
export type UpdatePolicyArgs = z.infer<typeof UpdatePolicyArgsSchema>;

/** verifier.init_verifier_config argümanları. */
export const InitVerifierConfigArgsSchema = z.object({
  escrowProgram: Address,
  policyProgram: Address,
  mppAuthority: Address,
});
export type InitVerifierConfigArgs = z.infer<typeof InitVerifierConfigArgsSchema>;

/** verifier.record_release argümanları. */
export const RecordReleaseArgsSchema = z.object({});
export type RecordReleaseArgs = z.infer<typeof RecordReleaseArgsSchema>;

/** verifier.set_compliance_proof argümanları. */
export const SetComplianceProofArgsSchema = z.object({
  proofA: hexBytes(64),
  proofB: hexBytes(128),
  proofC: hexBytes(64),
  refusalCode: z.number().int().min(0).max(65535),
  netAmount: U64,
  proofTimestamp: I64,
});
export type SetComplianceProofArgs = z.infer<typeof SetComplianceProofArgsSchema>;

/** verifier.sync_vk_version argümanları. */
export const SyncVkVersionArgsSchema = z.object({});
export type SyncVkVersionArgs = z.infer<typeof SyncVkVersionArgsSchema>;

/** verifier.update_mpp_authority argümanları. */
export const UpdateMppAuthorityArgsSchema = z.object({
  mppAuthority: Address,
});
export type UpdateMppAuthorityArgs = z.infer<typeof UpdateMppAuthorityArgsSchema>;

/** verifier.verify_mpp_payment_proof argümanları. */
export const VerifyMppPaymentProofArgsSchema = z.object({
  proofA: hexBytes(64),
  proofB: hexBytes(128),
  proofC: hexBytes(64),
  publicInputs: z.array(Hex32).length(10),
});
export type VerifyMppPaymentProofArgs = z.infer<typeof VerifyMppPaymentProofArgsSchema>;

/** escrow.accept_job argümanları. */
export const AcceptJobArgsSchema = z.object({
  specHash: Hex32,
});
export type AcceptJobArgs = z.infer<typeof AcceptJobArgsSchema>;

/** escrow.buy_claim argümanları. */
export const BuyClaimArgsSchema = z.object({
  price: U64,
  leafSalt: Hex32,
  merkleProof: z.array(Hex32),
});
export type BuyClaimArgs = z.infer<typeof BuyClaimArgsSchema>;

/** escrow.cancel_claim argümanları. */
export const CancelClaimArgsSchema = z.object({});
export type CancelClaimArgs = z.infer<typeof CancelClaimArgsSchema>;

/** escrow.cancel_job argümanları. */
export const CancelJobArgsSchema = z.object({});
export type CancelJobArgs = z.infer<typeof CancelJobArgsSchema>;

/** escrow.commit_travel_rule argümanları. */
export const CommitTravelRuleArgsSchema = z.object({
  commitment: Hex32,
});
export type CommitTravelRuleArgs = z.infer<typeof CommitTravelRuleArgsSchema>;

/** escrow.create_job argümanları. */
export const CreateJobArgsSchema = z.object({
  specHash: Hex32,
  amount: U64,
  deadline: I64,
  challengePeriod: U64,
});
export type CreateJobArgs = z.infer<typeof CreateJobArgsSchema>;

/** escrow.escalate_missing_proof argümanları. */
export const EscalateMissingProofArgsSchema = z.object({});
export type EscalateMissingProofArgs = z.infer<typeof EscalateMissingProofArgsSchema>;

/** escrow.execute_resolution argümanları. */
export const ExecuteResolutionArgsSchema = z.object({});
export type ExecuteResolutionArgs = z.infer<typeof ExecuteResolutionArgsSchema>;

/** escrow.finalize_payment argümanları. */
export const FinalizePaymentArgsSchema = z.object({});
export type FinalizePaymentArgs = z.infer<typeof FinalizePaymentArgsSchema>;

/** escrow.fund_job argümanları. */
export const FundJobArgsSchema = z.object({});
export type FundJobArgs = z.infer<typeof FundJobArgsSchema>;

/** escrow.init_config argümanları. */
export const InitConfigArgsSchema = z.object({
  settlementMint: Address,
  arbitrators: z.array(Address),
  threshold: z.number().int().min(0).max(255),
  params: EscrowParamsSchema,
  linked: LinkedProgramsSchema,
});
export type InitConfigArgs = z.infer<typeof InitConfigArgsSchema>;

/** escrow.lapse_dispute argümanları. */
export const LapseDisputeArgsSchema = z.object({});
export type LapseDisputeArgs = z.infer<typeof LapseDisputeArgsSchema>;

/** escrow.list_claim argümanları. */
export const ListClaimArgsSchema = z.object({
  price: U64,
});
export type ListClaimArgs = z.infer<typeof ListClaimArgsSchema>;

/** escrow.raise_dispute argümanları. */
export const RaiseDisputeArgsSchema = z.object({
  reasonHash: Hex32,
  bond: U64,
});
export type RaiseDisputeArgs = z.infer<typeof RaiseDisputeArgsSchema>;

/** escrow.resolve_dispute argümanları. */
export const ResolveDisputeArgsSchema = z.object({
  resolution: DisputeResolutionSchema,
});
export type ResolveDisputeArgs = z.infer<typeof ResolveDisputeArgsSchema>;

/** escrow.submit_work argümanları. */
export const SubmitWorkArgsSchema = z.object({
  workHash: Hex32,
  deliveryUri: z.string(),
});
export type SubmitWorkArgs = z.infer<typeof SubmitWorkArgsSchema>;

/** escrow.sync_agent_wallet argümanları. */
export const SyncAgentWalletArgsSchema = z.object({});
export type SyncAgentWalletArgs = z.infer<typeof SyncAgentWalletArgsSchema>;

/** escrow.update_arbitrators argümanları. */
export const UpdateArbitratorsArgsSchema = z.object({
  arbitrators: z.array(Address),
  threshold: z.number().int().min(0).max(255),
});
export type UpdateArbitratorsArgs = z.infer<typeof UpdateArbitratorsArgsSchema>;

/** escrow.update_params argümanları. */
export const UpdateParamsArgsSchema = z.object({
  params: EscrowParamsSchema,
});
export type UpdateParamsArgs = z.infer<typeof UpdateParamsArgsSchema>;

/** Program + instruction + IDL kodlamasıyla argümanlar. */
export const InstructionCallSchema = z.discriminatedUnion('instruction', [
  z.object({ program: z.literal('registry'), instruction: z.literal('deregisterAgent'), args: DeregisterAgentArgsSchema }),
  z.object({ program: z.literal('registry'), instruction: z.literal('initRegistryConfig'), args: InitRegistryConfigArgsSchema }),
  z.object({ program: z.literal('registry'), instruction: z.literal('recordScreening'), args: RecordScreeningArgsSchema }),
  z.object({ program: z.literal('registry'), instruction: z.literal('registerAgent'), args: RegisterAgentArgsSchema }),
  z.object({ program: z.literal('registry'), instruction: z.literal('setAgentStatus'), args: SetAgentStatusArgsSchema }),
  z.object({ program: z.literal('registry'), instruction: z.literal('transferAgentOwnership'), args: TransferAgentOwnershipArgsSchema }),
  z.object({ program: z.literal('registry'), instruction: z.literal('updateAgent'), args: UpdateAgentArgsSchema }),
  z.object({ program: z.literal('registry'), instruction: z.literal('updateRegistryConfig'), args: UpdateRegistryConfigArgsSchema }),
  z.object({ program: z.literal('policy'), instruction: z.literal('deactivatePolicy'), args: DeactivatePolicyArgsSchema }),
  z.object({ program: z.literal('policy'), instruction: z.literal('initInstitution'), args: InitInstitutionArgsSchema }),
  z.object({ program: z.literal('policy'), instruction: z.literal('setBuyerRoot'), args: SetBuyerRootArgsSchema }),
  z.object({ program: z.literal('policy'), instruction: z.literal('setInstitutionMultisig'), args: SetInstitutionMultisigArgsSchema }),
  z.object({ program: z.literal('policy'), instruction: z.literal('setPolicy'), args: SetPolicyArgsSchema }),
  z.object({ program: z.literal('policy'), instruction: z.literal('updatePolicy'), args: UpdatePolicyArgsSchema }),
  z.object({ program: z.literal('verifier'), instruction: z.literal('initVerifierConfig'), args: InitVerifierConfigArgsSchema }),
  z.object({ program: z.literal('verifier'), instruction: z.literal('recordRelease'), args: RecordReleaseArgsSchema }),
  z.object({ program: z.literal('verifier'), instruction: z.literal('setComplianceProof'), args: SetComplianceProofArgsSchema }),
  z.object({ program: z.literal('verifier'), instruction: z.literal('syncVkVersion'), args: SyncVkVersionArgsSchema }),
  z.object({ program: z.literal('verifier'), instruction: z.literal('updateMppAuthority'), args: UpdateMppAuthorityArgsSchema }),
  z.object({ program: z.literal('verifier'), instruction: z.literal('verifyMppPaymentProof'), args: VerifyMppPaymentProofArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('acceptJob'), args: AcceptJobArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('buyClaim'), args: BuyClaimArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('cancelClaim'), args: CancelClaimArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('cancelJob'), args: CancelJobArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('commitTravelRule'), args: CommitTravelRuleArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('createJob'), args: CreateJobArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('escalateMissingProof'), args: EscalateMissingProofArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('executeResolution'), args: ExecuteResolutionArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('finalizePayment'), args: FinalizePaymentArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('fundJob'), args: FundJobArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('initConfig'), args: InitConfigArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('lapseDispute'), args: LapseDisputeArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('listClaim'), args: ListClaimArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('raiseDispute'), args: RaiseDisputeArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('resolveDispute'), args: ResolveDisputeArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('submitWork'), args: SubmitWorkArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('syncAgentWallet'), args: SyncAgentWalletArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('updateArbitrators'), args: UpdateArbitratorsArgsSchema }),
  z.object({ program: z.literal('escrow'), instruction: z.literal('updateParams'), args: UpdateParamsArgsSchema }),
]);
export type InstructionCall = z.infer<typeof InstructionCallSchema>;
