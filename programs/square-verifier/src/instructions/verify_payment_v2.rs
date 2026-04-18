use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use crate::groth16_vk::{APERTURE_PAYMENT_VK, PAYMENT_NR_INPUTS};
use crate::state::{ProofRecord, ComplianceStatus};

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
)]
pub struct VerifyPaymentProofV2<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ProofRecord::INIT_SPACE,
        seeds = [b"proof", operator.key().as_ref(), &public_inputs[1]],
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

    /// CHECK: Policy account from policy-registry program, referenced by the
    /// operator off-chain to derive the circuit inputs. The verifier does not
    /// read it; it only records the key alongside the proof.
    pub policy_account: UncheckedAccount<'info>,

    pub operator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Verify a Circom-generated Groth16 proof for the payment-compliance
/// circuit. The proof commits two public inputs:
///   public_inputs[0] = is_compliant  (0 or 1, big-endian 32-byte encoding)
///   public_inputs[1] = journal_digest (Poseidon commitment over policy+payment)
pub fn handler(
    ctx: Context<VerifyPaymentProofV2>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
) -> Result<()> {
    // 1. Cryptographic Groth16 verification via alt_bn128 syscalls.
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

    // 2. Decode is_compliant from the first public input. The circuit writes
    //    the boolean as a BN254 field element, so we accept only the two
    //    canonical encodings; anything else indicates tampering.
    let is_compliant_bytes = public_inputs[0];
    let is_compliant = match is_compliant_bytes {
        b if b == [0u8; 32] => false,
        mut b => {
            let last = b[31];
            b[31] = 0;
            if b == [0u8; 32] && last == 1 {
                true
            } else {
                return err!(VerifierV2Error::MalformedPublicInput);
            }
        }
    };

    // 3. journal_digest is the second public input, kept as the 32-byte
    //    commitment used to seed the ProofRecord PDA.
    let journal_digest = public_inputs[1];

    // 4. Persist the proof record and update the operator compliance status
    //    so the transfer hook can enforce gating downstream.
    let clock = Clock::get()?;
    let proof = &mut ctx.accounts.proof_record;
    proof.operator = ctx.accounts.operator.key();
    proof.policy_id = ctx.accounts.policy_account.key().to_bytes();
    proof.proof_hash = journal_digest;
    proof.image_id = [0u32; 8];
    proof.journal_digest = journal_digest;
    proof.timestamp = clock.unix_timestamp;
    proof.verified = true;
    proof.bump = ctx.bumps.proof_record;

    let status = &mut ctx.accounts.compliance_status;
    status.operator = ctx.accounts.operator.key();
    status.is_compliant = is_compliant;
    status.last_proof_hash = journal_digest;
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
    #[msg("Groth16 proof is malformed or has invalid byte layout")]
    MalformedProof,
    #[msg("Groth16 proof verification failed on-chain")]
    ProofVerificationFailed,
    #[msg("Public input has an invalid canonical encoding")]
    MalformedPublicInput,
}
