use anchor_lang::prelude::*;

pub mod groth16_vk;
pub mod instructions;
pub mod state;

use groth16_vk::{BATCH_NR_INPUTS, PAYMENT_NR_INPUTS};
use instructions::*;

declare_id!("AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU");

#[program]
pub mod verifier {
    use super::*;

    pub fn verify_payment_proof(
        ctx: Context<VerifyPaymentProof>,
        proof_hash: [u8; 32],
        image_id: [u32; 8],
        journal_digest: [u8; 32],
        receipt_data: Vec<u8>,
    ) -> Result<()> {
        instructions::verify_payment::handler(ctx, proof_hash, image_id, journal_digest, receipt_data)
    }

    pub fn verify_batch_attestation(
        ctx: Context<VerifyBatchAttestation>,
        batch_hash: [u8; 32],
        image_id: [u32; 8],
        journal_digest: [u8; 32],
        total_payments: u32,
        period_start: i64,
        period_end: i64,
        receipt_data: Vec<u8>,
    ) -> Result<()> {
        instructions::verify_batch::handler(
            ctx,
            batch_hash,
            image_id,
            journal_digest,
            total_payments,
            period_start,
            period_end,
            receipt_data,
        )
    }

    /// v2: Verifies a Circom-generated Groth16 proof for the payment-compliance
    /// circuit via on-chain alt_bn128 pairings (groth16-solana). The two
    /// public inputs carry is_compliant and journal_digest; no other fields
    /// from the old receipt-based flow are needed.
    pub fn verify_payment_proof_v2(
        ctx: Context<VerifyPaymentProofV2>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
    ) -> Result<()> {
        instructions::verify_payment_v2::handler(ctx, proof_a, proof_b, proof_c, public_inputs)
    }

    /// v2: Verifies a Circom-generated Groth16 proof for the batch-aggregator
    /// circuit. The Circom batch circuit does not exist yet; this instruction
    /// is kept for API shape parity and fails closed against the zeroed
    /// placeholder VK in groth16_vk.rs until the circuit ships.
    pub fn verify_batch_attestation_v2(
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
        instructions::verify_batch_v2::handler(
            ctx,
            batch_hash,
            image_id,
            journal_digest,
            total_payments,
            period_start,
            period_end,
            proof_a,
            proof_b,
            proof_c,
            public_inputs,
        )
    }
}
