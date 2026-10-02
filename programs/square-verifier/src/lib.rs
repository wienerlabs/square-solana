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
}
