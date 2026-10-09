//! square_escrow hata kodları (program arayüzü §10.4). Sıra sözleşmedir: kodlar 6000'den başlar ve
//! istemciler hatayı (program kimliği, kod) çiftiyle eşler.

use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    // ---- job lifecycle (Covenant guards kept) ----
    #[msg("Job is not in the required status for this operation")]
    InvalidStatus,
    #[msg("Job deadline has passed")]
    DeadlineExpired,
    #[msg("Job deadline has not passed yet")]
    DeadlineNotExpired,
    #[msg("Spec hash provided does not match committed hash")]
    SpecHashMismatch,
    #[msg("Signer is not authorized for this operation")]
    Unauthorized,
    #[msg("Payment amount must be greater than zero")]
    InvalidAmount,
    #[msg("Challenge period must be within protocol min/max bounds")]
    InvalidChallengePeriod,
    #[msg("Delivery URI exceeds maximum length")]
    DeliveryUriTooLong,
    #[msg("Challenge period has not expired yet")]
    ChallengePeriodNotExpired,
    #[msg("Token mint is not the settlement mint or the job mint")]
    MintMismatch,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Job is not funded")]
    JobNotFunded,
    // ---- agent binding / screening ----
    #[msg("Agent record is not a registered square_registry account")]
    AgentNotRegistered,
    #[msg("Agent record is not active")]
    AgentInactive,
    #[msg("Signer does not match the job's agent wallet")]
    AgentMismatch,
    #[msg("Screening record missing or not owned by square_registry")]
    ScreeningRequired,
    #[msg("Screening record has expired")]
    ScreeningExpired,
    #[msg("Wallet is flagged by sanctions screening")]
    ScreeningFlagged,
    // ---- disputes ----
    #[msg("Challenge window has already closed")]
    DisputeWindowClosed,
    #[msg("Dispute is already active on this job")]
    DisputeAlreadyActive,
    #[msg("This job already had a dispute")]
    DisputeAlreadyRaised,
    #[msg("No active dispute on this job")]
    NoActiveDispute,
    #[msg("Insufficient dispute bond provided")]
    InsufficientBond,
    #[msg("Signer is not an active arbitrator")]
    NotArbitrator,
    #[msg("Arbitrator has already voted on this proposal")]
    AlreadyVoted,
    #[msg("Vote must name a resolution")]
    ResolutionMismatch,
    #[msg("Dispute has not reached the arbitrator threshold")]
    ResolutionNotDecided,
    #[msg("Split amount exceeds the escrowed amount")]
    InvalidSplitAmount,
    #[msg("Threshold must satisfy 2 <= M <= N")]
    InvalidThreshold,
    #[msg("Arbitrator set exceeds MAX_ARBITRATORS or contains duplicates")]
    InvalidArbitratorSet,
    #[msg("Dispute deadline has not passed yet")]
    DisputeNotExpired,
    // ---- claim market ----
    #[msg("Claim price must be greater than zero and less than the face value")]
    InvalidClaimPrice,
    #[msg("Claim listing is not in the required status for this operation")]
    InvalidClaimStatus,
    #[msg("Claim listing references a different job")]
    ClaimListingMismatch,
    #[msg("A bought claim exists; payment must route to the buyer")]
    ClaimListingRequired,
    #[msg("Only the seller may cancel this listing")]
    NotClaimSeller,
    #[msg("Buyer may not be the seller")]
    BuyerIsSeller,
    #[msg("Buyer is not in the institution's approved buyer set")]
    BuyerNotEligible,
    #[msg("Listing price differs from the expected price")]
    ClaimPriceChanged,
    // ---- proof gate / keeper ----
    #[msg("Policy job: a release proof must be bound before release")]
    ProofRequired,
    #[msg("Release proof has the wrong owner, seeds or job")]
    InvalidReleaseProof,
    #[msg("Release proof is stale (payee, net amount, mint or daily counter changed)")]
    StaleReleaseProof,
    #[msg("Policy account does not match the job policy")]
    PolicyMismatch,
    #[msg("Policy is not active")]
    PolicyInactive,
    #[msg("Keeper fee exceeds the allowed maximum")]
    InvalidKeeperFee,
    #[msg("Account owner does not match the linked program in the config")]
    LinkedProgramMismatch,
    // ---- M5: proof timeout, Travel Rule, dispute timeout ----
    #[msg("Proof timeout has not passed yet")]
    ProofTimeoutNotReached,
    #[msg("Travel Rule commitment required above the threshold")]
    TravelRuleCommitmentRequired,
    #[msg("Dispute timeout must be positive and proof timeout must not be negative")]
    InvalidDisputeTimeout,
    // ---- M6: Stripe MPP fiat rail ----
    #[msg("Instruction does not apply to the job's settlement rail")]
    RailMismatch,
    // ---- ADR 0028: pre-acceptance preflight proof ----
    #[msg("Policy job: the institution must bind a preflight proof before the agent accepts")]
    PreflightRequired,
    #[msg("Job amount is above the policy's public daily ceiling")]
    AmountAboveDailyCeiling,
}
