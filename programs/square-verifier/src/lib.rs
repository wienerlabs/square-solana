use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("HrYMqPEiMnYSskmi3iAp57X8Ke6BiP2WsjGvMPEqBtmr");

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
}
