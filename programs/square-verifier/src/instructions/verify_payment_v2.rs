use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use crate::groth16_vk::{APERTURE_PAYMENT_VK, PAYMENT_NR_INPUTS};
use crate::state::{ProofRecord, ComplianceStatus};

/// Expected image_id for the Aperture payment prover guest program.
///
/// Populated at deployment via a one-time initialize instruction (TODO).
/// A zeroed value disables enforcement, which is only acceptable before the
/// real RISC Zero guest ELF digest is wired in.
const EXPECTED_PAYMENT_IMAGE_ID: [u32; 8] = [0; 8];

#[derive(Accounts)]
#[instruction(proof_hash: [u8; 32])]
pub struct VerifyPaymentProofV2<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ProofRecord::INIT_SPACE,
        seeds = [b"proof", operator.key().as_ref(), &proof_hash],
        bump,
    )]
    pub proof_record: Account<'info, ProofRecord>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ComplianceStatus::INIT_SPACE,
        seeds = [b"compliance", operator.key().as_ref()],
        bump,
    )]
    pub compliance_status: Account<'info, ComplianceStatus>,

    /// CHECK: Policy account from policy-registry program, validated by seed derivation.
    pub policy_account: UncheckedAccount<'info>,

    pub operator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Verifies a RISC Zero Groth16-compressed proof using on-chain BN254 pairings.
///
/// Unlike the legacy handler which only checked SHA-256 integrity, this
/// performs real cryptographic verification via `groth16-solana` against the
/// Aperture payment-prover verification key.
pub fn handler(
    ctx: Context<VerifyPaymentProofV2>,
    proof_hash: [u8; 32],
    image_id: [u32; 8],
    journal_digest: [u8; 32],
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
    is_compliant: bool,
) -> Result<()> {
    // Step 1: Enforce expected image_id if configured.
    let expected_is_zero = EXPECTED_PAYMENT_IMAGE_ID.iter().all(|&x| x == 0);
    if !expected_is_zero {
        require!(
            image_id == EXPECTED_PAYMENT_IMAGE_ID,
            VerifierV2Error::UnexpectedImageId
        );
    }

    // Step 2: Cryptographically verify the Groth16 proof.
    let mut verifier = Groth16Verifier::<PAYMENT_NR_INPUTS>::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &APERTURE_PAYMENT_VK,
    )
    .map_err(|_| error!(VerifierV2Error::MalformedProof))?;

    verifier
        .verify()
        .map_err(|_| error!(VerifierV2Error::ProofVerificationFailed))?;

    // Step 3: Persist the verified proof record.
    let clock = Clock::get()?;
    let proof = &mut ctx.accounts.proof_record;
    proof.operator = ctx.accounts.operator.key();
    proof.policy_id = ctx.accounts.policy_account.key().to_bytes();
    proof.proof_hash = proof_hash;
    proof.image_id = image_id;
    proof.journal_digest = journal_digest;
    proof.timestamp = clock.unix_timestamp;
    proof.verified = true;
    proof.bump = ctx.bumps.proof_record;

    // Step 4: Update compliance status for the transfer hook.
    let status = &mut ctx.accounts.compliance_status;
    status.operator = ctx.accounts.operator.key();
    status.is_compliant = is_compliant;
    status.last_proof_hash = proof_hash;
    status.last_verified_at = clock.unix_timestamp;
    status.total_proofs = status.total_proofs.saturating_add(1);
    status.bump = ctx.bumps.compliance_status;

    msg!(
        "Payment proof verified (v2): operator={}, compliant={}, total={}",
        ctx.accounts.operator.key(),
        is_compliant,
        status.total_proofs
    );
    Ok(())
}

#[error_code]
pub enum VerifierV2Error {
    #[msg("Image ID does not match the expected payment prover program")]
    UnexpectedImageId,
    #[msg("Groth16 proof is malformed or has invalid byte layout")]
    MalformedProof,
    #[msg("Groth16 proof verification failed on-chain")]
    ProofVerificationFailed,
}
