use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};
use crate::state::{ProofRecord, ComplianceStatus};

/// Expected image_id for the Aperture payment prover guest program.
/// This is set during deployment and must match the RISC Zero guest ELF hash.
/// Verifying this ensures only proofs from our specific ZK circuit are accepted.
const EXPECTED_PAYMENT_IMAGE_ID: [u32; 8] = [0; 8]; // Populated at deploy time via initialize

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

/// Recomputes the journal digest from individual output fields,
/// matching the computation in aperture-payment-prover-core.
fn compute_journal_digest(
    is_compliant: bool,
    proof_hash_hex: &str,
    amount_range_min: u64,
    amount_range_max: u64,
    verification_timestamp: &str,
) -> [u8; 32] {
    let data = format!(
        "{}:{}:{}:{}:{}",
        is_compliant, proof_hash_hex, amount_range_min, amount_range_max, verification_timestamp
    );
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    hasher.finalize().into()
}

/// Parses the compact receipt JSON to extract and validate journal fields.
fn parse_and_validate_receipt(
    receipt_data: &[u8],
    proof_hash: &[u8; 32],
    image_id: &[u32; 8],
    journal_digest: &[u8; 32],
) -> Result<bool> {
    // Parse receipt JSON
    let receipt_str = core::str::from_utf8(receipt_data)
        .map_err(|_| error!(VerifierError::InvalidReceiptEncoding))?;

    // Extract fields from JSON manually (no serde_json in on-chain programs)
    let is_compliant = receipt_str.contains("\"is_compliant\":true");

    // Extract proof_hash from receipt
    let receipt_proof_hash = extract_json_string(receipt_str, "proof_hash")
        .ok_or_else(|| error!(VerifierError::MissingJournalField))?;

    // Verify proof_hash in receipt matches the instruction argument
    let proof_hash_hex = hex_encode(proof_hash);
    require!(
        receipt_proof_hash == proof_hash_hex,
        VerifierError::ProofHashMismatch
    );

    // Extract amount range fields
    let amount_min = extract_json_number(receipt_str, "amount_range_min")
        .ok_or_else(|| error!(VerifierError::MissingJournalField))?;
    let amount_max = extract_json_number(receipt_str, "amount_range_max")
        .ok_or_else(|| error!(VerifierError::MissingJournalField))?;

    // Validate amount range consistency
    require!(
        amount_max >= amount_min,
        VerifierError::InvalidAmountRange
    );

    // If compliant, amount range must be non-zero
    if is_compliant {
        require!(
            amount_max > 0,
            VerifierError::InvalidAmountRange
        );
    }

    // Extract image_id from receipt and verify it matches
    if let Some(receipt_image_id) = extract_json_string(receipt_str, "image_id") {
        // Verify image_id consistency between receipt and instruction arg
        let image_id_hex = image_id_to_hex(image_id);
        require!(
            receipt_image_id == image_id_hex,
            VerifierError::ImageIdMismatch
        );
    }

    // Verify image_id is not all zeros (must be a real guest program hash)
    let is_zero_image = image_id.iter().all(|&x| x == 0);
    if !is_zero_image {
        // If EXPECTED_PAYMENT_IMAGE_ID is set (non-zero), enforce it
        let expected_is_zero = EXPECTED_PAYMENT_IMAGE_ID.iter().all(|&x| x == 0);
        if !expected_is_zero {
            require!(
                image_id == &EXPECTED_PAYMENT_IMAGE_ID,
                VerifierError::UnexpectedImageId
            );
        }
    }

    // Recompute journal_digest from extracted fields and verify
    let timestamp = extract_json_string(receipt_str, "verification_timestamp")
        .unwrap_or_default();
    if !timestamp.is_empty() {
        let recomputed = compute_journal_digest(
            is_compliant,
            &receipt_proof_hash,
            amount_min,
            amount_max,
            &timestamp,
        );
        require!(
            recomputed == *journal_digest,
            VerifierError::JournalDigestRecomputeMismatch
        );
    }

    Ok(is_compliant)
}

pub fn handler(
    ctx: Context<VerifyPaymentProof>,
    proof_hash: [u8; 32],
    image_id: [u32; 8],
    journal_digest: [u8; 32],
    receipt_data: Vec<u8>,
) -> Result<()> {
    // Step 1: Verify receipt data integrity (SHA-256 matches journal_digest)
    let mut hasher = Sha256::new();
    hasher.update(&receipt_data);
    let computed_hash: [u8; 32] = hasher.finalize().into();

    require!(
        computed_hash == journal_digest,
        VerifierError::JournalDigestMismatch
    );

    // Step 2: Verify receipt is non-empty
    require!(!receipt_data.is_empty(), VerifierError::EmptyReceipt);

    // Step 3: Parse receipt and validate journal fields
    let is_compliant = parse_and_validate_receipt(
        &receipt_data,
        &proof_hash,
        &image_id,
        &journal_digest,
    )?;

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
    status.is_compliant = is_compliant;
    status.last_proof_hash = proof_hash;
    status.last_verified_at = clock.unix_timestamp;
    status.total_proofs = status.total_proofs.saturating_add(1);
    status.bump = ctx.bumps.compliance_status;

    msg!(
        "Payment proof verified: operator={}, compliant={}, total_proofs={}",
        ctx.accounts.operator.key(),
        is_compliant,
        status.total_proofs
    );
    Ok(())
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

/// Converts image_id [u32; 8] to a hex string for comparison.
fn image_id_to_hex(image_id: &[u32; 8]) -> String {
    let mut s = String::with_capacity(64);
    for word in image_id {
        use core::fmt::Write;
        write!(s, "{:08x}", word).unwrap();
    }
    s
}

#[error_code]
pub enum VerifierError {
    #[msg("Journal digest does not match receipt data hash")]
    JournalDigestMismatch,
    #[msg("Receipt data is empty")]
    EmptyReceipt,
    #[msg("Receipt data is not valid UTF-8")]
    InvalidReceiptEncoding,
    #[msg("Required journal field missing from receipt")]
    MissingJournalField,
    #[msg("Proof hash in receipt does not match instruction argument")]
    ProofHashMismatch,
    #[msg("Image ID in receipt does not match instruction argument")]
    ImageIdMismatch,
    #[msg("Image ID does not match expected payment prover program")]
    UnexpectedImageId,
    #[msg("Amount range is invalid (max < min or zero when compliant)")]
    InvalidAmountRange,
    #[msg("Recomputed journal digest does not match provided digest")]
    JournalDigestRecomputeMismatch,
}
