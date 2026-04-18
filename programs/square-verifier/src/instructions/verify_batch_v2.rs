use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use crate::groth16_vk::{APERTURE_BATCH_VK, BATCH_NR_INPUTS};
use crate::state::AttestationRecord;

/// Expected image_id for the Aperture batch-aggregator guest program.
///
/// Populated at deployment via a one-time initialize instruction (TODO).
const EXPECTED_BATCH_IMAGE_ID: [u32; 8] = [0; 8];

#[derive(Accounts)]
#[instruction(batch_hash: [u8; 32])]
pub struct VerifyBatchAttestationV2<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + AttestationRecord::INIT_SPACE,
        seeds = [b"attestation", operator.key().as_ref(), &batch_hash],
        bump,
    )]
    pub attestation_record: Account<'info, AttestationRecord>,

    pub operator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Verifies a RISC Zero Groth16-compressed batch attestation proof on-chain.
pub fn handler(
    ctx: Context<VerifyBatchAttestationV2>,
    batch_hash: [u8; 32],
    image_id: [u32; 8],
    journal_digest: [u8; 32],
    total_payments: u32,
    period_start: i64,
    period_end: i64,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; BATCH_NR_INPUTS],
) -> Result<()> {
    // Step 1: Validate batch period semantics.
    require!(period_end > period_start, BatchVerifierV2Error::InvalidPeriod);
    require!(total_payments > 0, BatchVerifierV2Error::EmptyBatch);

    // Step 2: Enforce expected image_id if configured.
    let expected_is_zero = EXPECTED_BATCH_IMAGE_ID.iter().all(|&x| x == 0);
    if !expected_is_zero {
        require!(
            image_id == EXPECTED_BATCH_IMAGE_ID,
            BatchVerifierV2Error::UnexpectedImageId
        );
    }

    // Step 3: Cryptographically verify the Groth16 proof.
    let mut verifier = Groth16Verifier::<BATCH_NR_INPUTS>::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &APERTURE_BATCH_VK,
    )
    .map_err(|_| error!(BatchVerifierV2Error::MalformedProof))?;

    verifier
        .verify()
        .map_err(|_| error!(BatchVerifierV2Error::ProofVerificationFailed))?;

    // Step 4: Persist the attestation record.
    let attestation = &mut ctx.accounts.attestation_record;
    let clock = Clock::get()?;

    attestation.operator = ctx.accounts.operator.key();
    attestation.batch_hash = batch_hash;
    attestation.image_id = image_id;
    attestation.journal_digest = journal_digest;
    attestation.total_payments = total_payments;
    attestation.period_start = period_start;
    attestation.period_end = period_end;
    attestation.timestamp = clock.unix_timestamp;
    attestation.verified = true;
    attestation.bump = ctx.bumps.attestation_record;

    msg!(
        "Batch attestation verified (v2): {} payments, operator {}, period {}-{}",
        total_payments,
        ctx.accounts.operator.key(),
        period_start,
        period_end
    );
    Ok(())
}

#[error_code]
pub enum BatchVerifierV2Error {
    #[msg("Period end must be after period start")]
    InvalidPeriod,
    #[msg("Batch must contain at least one payment")]
    EmptyBatch,
    #[msg("Image ID does not match the expected batch aggregator program")]
    UnexpectedImageId,
    #[msg("Groth16 proof is malformed or has invalid byte layout")]
    MalformedProof,
    #[msg("Groth16 proof verification failed on-chain")]
    ProofVerificationFailed,
}
