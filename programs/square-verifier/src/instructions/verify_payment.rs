use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};
use crate::state::{ProofRecord, ComplianceStatus};

#[derive(Accounts)]
#[instruction(proof_hash: [u8; 32])]
pub struct VerifyPaymentProof<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ProofRecord::INIT_SPACE,
        seeds = [b"proof", operator.key().as_ref(), &proof_hash],
        bump,
    )]
    pub proof_record: Account<'info, ProofRecord>,

    /// ComplianceStatus PDA -- created or updated on each successful verification
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ComplianceStatus::INIT_SPACE,
        seeds = [b"compliance", operator.key().as_ref()],
        bump,
    )]
    pub compliance_status: Account<'info, ComplianceStatus>,

    /// CHECK: Policy account from policy-registry program, validated by seed derivation
    pub policy_account: UncheckedAccount<'info>,

    pub operator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<VerifyPaymentProof>,
    proof_hash: [u8; 32],
    image_id: [u32; 8],
    journal_digest: [u8; 32],
    receipt_data: Vec<u8>,
) -> Result<()> {
    // Verify the receipt data integrity by checking SHA-256 matches journal_digest
    let mut hasher = Sha256::new();
    hasher.update(&receipt_data);
    let computed_hash: [u8; 32] = hasher.finalize().into();

    require!(
        computed_hash == journal_digest,
        VerifierError::JournalDigestMismatch
    );

    // Verify receipt is non-empty
    require!(!receipt_data.is_empty(), VerifierError::EmptyReceipt);

    let clock = Clock::get()?;

    // Store proof record
    let proof = &mut ctx.accounts.proof_record;
    proof.operator = ctx.accounts.operator.key();
    proof.policy_id = ctx.accounts.policy_account.key().to_bytes();
    proof.proof_hash = proof_hash;
    proof.image_id = image_id;
    proof.journal_digest = journal_digest;
    proof.timestamp = clock.unix_timestamp;
    proof.verified = true;
    proof.bump = ctx.bumps.proof_record;

    // Update compliance status (allows transfer hook to verify operator compliance)
    let status = &mut ctx.accounts.compliance_status;
    status.operator = ctx.accounts.operator.key();
    status.is_compliant = true;
    status.last_proof_hash = proof_hash;
    status.last_verified_at = clock.unix_timestamp;
    status.total_proofs = status.total_proofs.saturating_add(1);
    status.bump = ctx.bumps.compliance_status;

    msg!(
        "Payment proof verified for operator {}",
        ctx.accounts.operator.key()
    );
    Ok(())
}

#[error_code]
pub enum VerifierError {
    #[msg("Journal digest does not match receipt data hash")]
    JournalDigestMismatch,
    #[msg("Receipt data is empty")]
    EmptyReceipt,
}
