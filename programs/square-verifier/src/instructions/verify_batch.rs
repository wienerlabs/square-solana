use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};
use crate::state::AttestationRecord;

#[derive(Accounts)]
#[instruction(batch_hash: [u8; 32])]
pub struct VerifyBatchAttestation<'info> {
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

pub fn handler(
    ctx: Context<VerifyBatchAttestation>,
    batch_hash: [u8; 32],
    image_id: [u32; 8],
    journal_digest: [u8; 32],
    total_payments: u32,
    period_start: i64,
    period_end: i64,
    receipt_data: Vec<u8>,
) -> Result<()> {
    require!(period_end > period_start, BatchVerifierError::InvalidPeriod);

    let mut hasher = Sha256::new();
    hasher.update(&receipt_data);
    let computed_hash: [u8; 32] = hasher.finalize().into();

    require!(
        computed_hash == journal_digest,
        BatchVerifierError::JournalDigestMismatch
    );

    require!(!receipt_data.is_empty(), BatchVerifierError::EmptyReceipt);

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
        "Batch attestation verified: {} payments for operator {}",
        total_payments,
        ctx.accounts.operator.key()
    );
    Ok(())
}

#[error_code]
pub enum BatchVerifierError {
    #[msg("Journal digest does not match receipt data hash")]
    JournalDigestMismatch,
    #[msg("Receipt data is empty")]
    EmptyReceipt,
    #[msg("Period end must be after period start")]
    InvalidPeriod,
}
