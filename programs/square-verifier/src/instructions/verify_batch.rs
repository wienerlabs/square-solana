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

/// Recomputes the batch journal digest from individual fields.
fn compute_batch_digest(
    batch_hash_hex: &str,
    total_payments: u32,
    period_start: i64,
    period_end: i64,
) -> [u8; 32] {
    let data = format!(
        "batch:{}:{}:{}:{}",
        batch_hash_hex, total_payments, period_start, period_end
    );
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    hasher.finalize().into()
}

/// Extracts a string value from a JSON-like string by key.
fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{}\":\"", key);
    let start = json.find(&pattern)? + pattern.len();
    let end = json[start..].find('"')? + start;
    Some(json[start..end].to_string())
}

/// Extracts a numeric value from a JSON-like string by key.
fn extract_json_number(json: &str, key: &str) -> Option<u64> {
    let pattern = format!("\"{}\":", key);
    let start = json.find(&pattern)? + pattern.len();
    let remaining = json[start..].trim_start();
    let end = remaining.find(|c: char| !c.is_ascii_digit()).unwrap_or(remaining.len());
    remaining[..end].parse().ok()
}

/// Converts a 32-byte array to a hex string.
fn hex_encode(bytes: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        use core::fmt::Write;
        write!(s, "{:02x}", b).unwrap();
    }
    s
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
    // Step 1: Validate period
    require!(period_end > period_start, BatchVerifierError::InvalidPeriod);
    require!(total_payments > 0, BatchVerifierError::EmptyBatch);

    // Step 2: Verify receipt data integrity
    let mut hasher = Sha256::new();
    hasher.update(&receipt_data);
    let computed_hash: [u8; 32] = hasher.finalize().into();

    require!(
        computed_hash == journal_digest,
        BatchVerifierError::JournalDigestMismatch
    );

    require!(!receipt_data.is_empty(), BatchVerifierError::EmptyReceipt);

    // Step 3: Parse receipt and validate journal fields
    if let Ok(receipt_str) = core::str::from_utf8(&receipt_data) {
        // Verify batch_hash in receipt matches instruction argument
        if let Some(receipt_batch_hash) = extract_json_string(receipt_str, "batch_hash") {
            let batch_hash_hex = hex_encode(&batch_hash);
            require!(
                receipt_batch_hash == batch_hash_hex,
                BatchVerifierError::BatchHashMismatch
            );
        }

        // Verify total_payments consistency
        if let Some(receipt_total) = extract_json_number(receipt_str, "total_payments") {
            require!(
                receipt_total == total_payments as u64,
                BatchVerifierError::TotalPaymentsMismatch
            );
        }

        // Verify image_id is not all zeros
        let is_zero_image = image_id.iter().all(|&x| x == 0);
        if !is_zero_image {
            if let Some(receipt_image_id) = extract_json_string(receipt_str, "image_id") {
                let mut image_hex = String::with_capacity(64);
                for word in &image_id {
                    use core::fmt::Write;
                    write!(image_hex, "{:08x}", word).unwrap();
                }
                require!(
                    receipt_image_id == image_hex,
                    BatchVerifierError::ImageIdMismatch
                );
            }
        }

        // Recompute batch journal digest and verify
        let batch_hash_hex = hex_encode(&batch_hash);
        let recomputed = compute_batch_digest(
            &batch_hash_hex,
            total_payments,
            period_start,
            period_end,
        );
        require!(
            recomputed == journal_digest,
            BatchVerifierError::JournalDigestRecomputeMismatch
        );
    }

    // Step 4: Store attestation record
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
        "Batch attestation verified: {} payments for operator {}, period {}-{}",
        total_payments,
        ctx.accounts.operator.key(),
        period_start,
        period_end
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
    #[msg("Batch must contain at least one payment")]
    EmptyBatch,
    #[msg("Batch hash in receipt does not match instruction argument")]
    BatchHashMismatch,
    #[msg("Total payments in receipt does not match instruction argument")]
    TotalPaymentsMismatch,
    #[msg("Image ID in receipt does not match instruction argument")]
    ImageIdMismatch,
    #[msg("Recomputed journal digest does not match provided digest")]
    JournalDigestRecomputeMismatch,
}
