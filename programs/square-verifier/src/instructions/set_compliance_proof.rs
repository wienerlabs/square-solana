use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use square_common::contract::square_escrow_contract::types::SettlementRail;
use square_common::seeds::{
    CLAIM_SEED, OPERATOR_STATE_SEED, RELEASE_PROOF_SEED, VERIFIER_CONFIG_SEED,
};

use crate::errors::VerifierError;
use crate::release_vk::{RELEASE_NR_INPUTS, SQUARE_RELEASE_VK};
use crate::signals::{ReleaseSignals, NO_STRIPE_RECEIPT};
use crate::state::{OperatorState, ReleaseProof, ReleaseVerdict, VerifierConfig};
use crate::ComplianceProofSet;
use crate::{binding, linked};

#[derive(Accounts)]
pub struct SetComplianceProof<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The institution's current authority (key, or its Squads vault once bound).
    pub authority: Signer<'info>,
    #[account(seeds = [VERIFIER_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VerifierConfig>,
    /// CHECK: square_policy `Institution` (owner = `config.policy_program`, seeds re-derived).
    pub institution: UncheckedAccount<'info>,
    /// CHECK: square_policy `Policy` of the job; `policy.institution == institution`.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: square_escrow `Job` (owner = `config.escrow_program`); Delivered, Disputed or Resolved,
    /// `job.policy == policy`; supplies the policy snapshot, mint and default payee.
    pub job: UncheckedAccount<'info>,
    /// CHECK: square_escrow `ClaimListing`; may be uninitialized. `Bought` makes the buyer the payee.
    #[account(
        seeds = [CLAIM_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.escrow_program.key()
    )]
    pub claim_listing: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + OperatorState::INIT_SPACE,
        seeds = [OPERATOR_STATE_SEED, institution.key().as_ref()],
        bump
    )]
    pub operator_state: Account<'info, OperatorState>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ReleaseProof::INIT_SPACE,
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump
    )]
    pub release_proof: Account<'info, ReleaseProof>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<SetComplianceProof>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    refusal_code: u16,
    net_amount: u64,
    proof_timestamp: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let config = &accounts.config;

    let authority = linked::institution_authority(&accounts.institution, &config.policy_program)?;
    require_keys_eq!(
        accounts.authority.key(),
        authority,
        VerifierError::Unauthorized
    );
    let institution = accounts.institution.key();
    linked::require_policy_of(&accounts.policy, &institution, &config.policy_program)?;
    let job_key = accounts.job.key();
    let job = linked::job(&accounts.job, &config.escrow_program)?;
    require!(
        job.policy == Some(accounts.policy.key()),
        VerifierError::PolicyMismatch
    );
    // Fiat işin ödemesi Stripe'tadır; ispatı `verify_mpp_payment_proof` bağlar (ADR 0024).
    require!(
        matches!(job.rail, SettlementRail::Escrow),
        VerifierError::RailMismatch
    );
    linked::require_bindable(&job)?;
    require!(
        !accounts.release_proof.consumed,
        VerifierError::ProofAlreadyConsumed
    );

    binding::require_current(proof_timestamp, now)?;
    let daily_spent_before =
        binding::daily_spent_before(&accounts.operator_state, proof_timestamp)?;

    let payee = linked::payee(
        &job_key,
        &job,
        &accounts.claim_listing,
        &config.escrow_program,
    )?;
    let inputs = ReleaseSignals {
        refusal_code,
        policy_commitment: job.policy_commitment,
        daily_ceiling: job.policy_daily_ceiling,
        payee,
        net_amount,
        mint: job.mint,
        daily_spent_before,
        proof_timestamp: proof_timestamp as u64,
        job: job_key,
        stripe_receipt_hash: NO_STRIPE_RECEIPT,
    }
    .public_inputs();
    let verified = Groth16Verifier::<RELEASE_NR_INPUTS>::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &inputs,
        &SQUARE_RELEASE_VK,
    )
    .is_ok_and(|mut verifier| verifier.verify().is_ok());
    require!(verified, VerifierError::InvalidProof);

    binding::open_operator_state(
        &mut ctx.accounts.operator_state,
        institution,
        proof_timestamp,
        ctx.bumps.operator_state,
    );
    let verdict = if refusal_code == 0 {
        ReleaseVerdict::Compliant
    } else {
        ReleaseVerdict::Refused
    };
    let policy = ctx.accounts.policy.key();
    ctx.accounts.release_proof.set_inner(ReleaseProof {
        job: job_key,
        institution,
        policy,
        payee,
        net_amount,
        mint: job.mint,
        daily_spent_before,
        proof_timestamp,
        verdict,
        refusal_code,
        consumed: false,
        bump: ctx.bumps.release_proof,
    });
    emit!(ComplianceProofSet {
        job: job_key,
        policy,
        verdict,
        refusal_code,
        payee,
        net_amount,
        mint: job.mint,
        daily_spent_before,
    });
    Ok(())
}
