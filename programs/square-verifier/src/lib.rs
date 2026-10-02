use anchor_lang::prelude::*;

pub mod groth16_vk;
pub mod instructions;
pub mod state;

use groth16_vk::PAYMENT_NR_INPUTS;
use instructions::*;

declare_id!("AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU");

#[program]
pub mod verifier {
    use super::*;

    /// v2: Verifies a Circom-generated Groth16 proof for the payment-compliance
    /// circuit via on-chain alt_bn128 pairings (groth16-solana).
    ///
    /// Disabled since BC-11 (fails with `TransferHookPathRemoved`): the binding
    /// and daily-spent update lived in the removed transfer-hook path. BC-21
    /// replaces it with `set_compliance_proof`.
    pub fn verify_payment_proof_v2(
        ctx: Context<VerifyPaymentProofV2>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
    ) -> Result<()> {
        instructions::verify_payment_v2::handler(ctx, proof_a, proof_b, proof_c, public_inputs)
    }

    /// Allocates the OperatorState PDA used to anchor on-chain daily spend.
    /// One-time setup per operator wallet; safe to skip because the verify
    /// instructions lazily initialize the same PDA via `init_if_needed`.
    pub fn initialize_operator_state(
        ctx: Context<InitializeOperatorState>,
    ) -> Result<()> {
        instructions::initialize_operator_state::handler(ctx)
    }

    /// MPP B-flow verifier: cross-checks a Stripe-attested ZK proof against
    /// the compliance-api's ed25519 signature (provided as the preceding
    /// instruction in the same tx via the Solana ed25519 native precompile),
    /// then atomically advances daily_spent in-line.
    pub fn verify_mpp_payment_proof(
        ctx: Context<VerifyMppPaymentProof>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
    ) -> Result<()> {
        instructions::verify_mpp_payment_proof::handler(
            ctx,
            proof_a,
            proof_b,
            proof_c,
            public_inputs,
        )
    }

    /// Disabled since BC-11 (fails with `TransferHookPathRemoved`): the
    /// Token-2022 CPI relied on the removed transfer-hook / `record_payment`
    /// path for proof consumption and the daily-spent update. BC-21 replaces it.
    ///
    /// Adım 9 — atomic verify + transfer for x402 payments.
    /// Equivalent to running verify_payment_proof_v2 followed by a
    /// transferCheckedWithTransferHook in the same tx, but bundled into a
    /// single instruction. The compliance gate the transfer-hook used to
    /// enforce (recipient/mint/amount byte-binding + daily_spent ceiling)
    /// is enforced here before the Token-2022 CPI fires, so skipping the
    /// hook does not weaken the security envelope.
    pub fn verify_payment_proof_v2_with_transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, VerifyPaymentProofV2WithTransfer<'info>>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
        transfer_amount: u64,
    ) -> Result<()> {
        instructions::verify_payment_v2_with_transfer::handler(
            ctx,
            proof_a,
            proof_b,
            proof_c,
            public_inputs,
            transfer_amount,
        )
    }
}
