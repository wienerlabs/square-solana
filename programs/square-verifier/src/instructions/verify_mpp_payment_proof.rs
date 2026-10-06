use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use solana_instructions_sysvar::get_instruction_relative;
use square_common::contract::square_escrow_contract::accounts::Job;
use square_common::contract::square_escrow_contract::types::{JobStatus, SettlementRail};
use square_common::mpp;
use square_common::seeds::{OPERATOR_STATE_SEED, RELEASE_PROOF_SEED, VERIFIER_CONFIG_SEED};

use crate::errors::VerifierError;
use crate::release_vk::{RELEASE_NR_INPUTS, SQUARE_RELEASE_VK};
use crate::signals::ReleaseSignals;
use crate::state::{OperatorState, ReleaseProof, ReleaseVerdict, VerifierConfig};
use crate::{binding, linked};
use crate::{ComplianceProofSet, MppPaymentVerified};

#[derive(Accounts)]
pub struct VerifyMppPaymentProof<'info> {
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
    /// CHECK: square_escrow `Job` (owner = `config.escrow_program`); fiat rail, Delivered,
    /// `job.policy == policy`; supplies the policy snapshot, amount, mint and payee (agent wallet).
    pub job: UncheckedAccount<'info>,
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
    /// CHECK: Instructions sysvar; the instruction right before this one must be the Ed25519
    /// precompile verifying the MPP authority's attestation.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Fiat iş: rayı fiat, teslim edilmiş ve politikası `policy`.
fn require_fiat_job(job: &Job, policy: &Pubkey) -> Result<()> {
    require!(job.policy == Some(*policy), VerifierError::PolicyMismatch);
    require!(
        matches!(job.rail, SettlementRail::Fiat),
        VerifierError::RailMismatch
    );
    require!(
        matches!(job.status, JobStatus::Delivered),
        VerifierError::InvalidJobState
    );
    Ok(())
}

/// Bu talimattan hemen önceki talimat, MPP authority'nin `job`'u, makbuzu ve tutarı bağlayan mesaj
/// üzerindeki imzasını doğrulayan Ed25519 precompile talimatıdır (ADR 0024).
fn require_attestation(
    instructions: &AccountInfo,
    mpp_authority: &Pubkey,
    job: &Pubkey,
    stripe_receipt_hash: &[u8; 32],
    amount: u64,
) -> Result<()> {
    let previous = get_instruction_relative(-1, instructions)
        .map_err(|_| error!(VerifierError::InvalidMppAttestation))?;
    require_keys_eq!(
        previous.program_id,
        solana_sdk_ids::ed25519_program::ID,
        VerifierError::InvalidMppAttestation
    );
    let message = mpp::attestation_message(job, stripe_receipt_hash, amount);
    mpp::verify_ed25519_instruction(&previous.data, mpp_authority, &message)
        .map_err(|_| error!(VerifierError::InvalidMppAttestation))
}

pub fn handler(
    ctx: Context<VerifyMppPaymentProof>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    stripe_receipt_hash: [u8; 32],
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
    let policy = accounts.policy.key();
    linked::require_policy_of(&accounts.policy, &institution, &config.policy_program)?;
    let job_key = accounts.job.key();
    let job = linked::job(&accounts.job, &config.escrow_program)?;
    require_fiat_job(&job, &policy)?;
    require!(
        !accounts.release_proof.consumed,
        VerifierError::ProofAlreadyConsumed
    );
    // Sıfır commitment escrow release yolunun değeridir; MPP ispatı bir makbuza bağlı olmalı.
    require!(
        stripe_receipt_hash != [0; 32],
        VerifierError::InvalidMppAttestation
    );
    require_attestation(
        &accounts.instructions,
        &config.mpp_authority,
        &job_key,
        &stripe_receipt_hash,
        job.amount,
    )?;

    binding::require_current(proof_timestamp, now)?;
    let daily_spent_before =
        binding::daily_spent_before(&accounts.operator_state, proof_timestamp)?;
    // Ödenen tutar işin tamamıdır ve ödeme yapılmıştır: ispat uyumlu olmalı (`refusal_code` 0). Fiat işin
    // alacağı satılmaz, payee agent cüzdanıdır.
    let inputs = ReleaseSignals {
        refusal_code: 0,
        policy_commitment: job.policy_commitment,
        daily_ceiling: job.policy_daily_ceiling,
        payee: job.agent_wallet,
        net_amount: job.amount,
        mint: job.mint,
        daily_spent_before,
        proof_timestamp: proof_timestamp as u64,
        job: job_key,
        stripe_receipt_hash,
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
    ctx.accounts.release_proof.set_inner(ReleaseProof {
        job: job_key,
        institution,
        policy,
        payee: job.agent_wallet,
        net_amount: job.amount,
        mint: job.mint,
        daily_spent_before,
        proof_timestamp,
        verdict: ReleaseVerdict::Compliant,
        refusal_code: 0,
        consumed: false,
        bump: ctx.bumps.release_proof,
    });
    emit!(ComplianceProofSet {
        job: job_key,
        policy,
        verdict: ReleaseVerdict::Compliant,
        refusal_code: 0,
        payee: job.agent_wallet,
        net_amount: job.amount,
        mint: job.mint,
        daily_spent_before,
    });
    emit!(MppPaymentVerified {
        job: job_key,
        institution,
        policy,
        stripe_receipt_hash,
        amount: job.amount,
    });
    Ok(())
}
