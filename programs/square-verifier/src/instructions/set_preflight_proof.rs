use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use square_common::contract::square_escrow_contract::types::JobStatus;
use square_common::release::preflight_accepts;
use square_common::seeds::{PREFLIGHT_PROOF_SEED, VERIFIER_CONFIG_SEED};

use crate::errors::VerifierError;
use crate::release_vk::{RELEASE_NR_INPUTS, SQUARE_RELEASE_VK};
use crate::signals::{ReleaseSignals, NO_STRIPE_RECEIPT};
use crate::state::{PreflightProof, VerifierConfig};
use crate::PreflightProofSet;
use crate::{binding, linked};

#[derive(Accounts)]
pub struct SetPreflightProof<'info> {
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
    /// CHECK: square_escrow `Job` (owner = `config.escrow_program`); Open or Funded (not yet accepted),
    /// `job.policy == policy`; supplies the policy snapshot, amount, mint and agent wallet.
    pub job: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PreflightProof::INIT_SPACE,
        seeds = [PREFLIGHT_PROOF_SEED, job.key().as_ref()],
        bump
    )]
    pub preflight_proof: Account<'info, PreflightProof>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SetPreflightProof>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    refusal_code: u16,
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
    let policy = accounts.policy.key();
    require!(job.policy == Some(policy), VerifierError::PolicyMismatch);
    // Ön-ispat kabulden öncedir: escrow işi fonlandıktan, fiat iş açıkken kabul edilir.
    require!(
        matches!(job.status, JobStatus::Open | JobStatus::Funded),
        VerifierError::InvalidJobState
    );
    // Kalıcı bitler ve sayaç 0 iken günlük tavan bitleri kesin rettir: böyle bir işin agent'ı ödenmez.
    require!(
        preflight_accepts(refusal_code),
        VerifierError::PreflightRefused
    );
    binding::require_current(proof_timestamp, now)?;

    // İşin kendi koşulları: agent tarafının her release'i net ≤ tutar, aynı payee ve sayaç ≥ 0 ile olur.
    let inputs = ReleaseSignals {
        refusal_code,
        policy_commitment: job.policy_commitment,
        daily_ceiling: job.policy_daily_ceiling,
        payee: job.agent_wallet,
        net_amount: job.amount,
        mint: job.mint,
        daily_spent_before: 0,
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

    ctx.accounts.preflight_proof.set_inner(PreflightProof {
        job: job_key,
        policy,
        payee: job.agent_wallet,
        policy_commitment: job.policy_commitment,
        refusal_code,
        proof_timestamp,
        bump: ctx.bumps.preflight_proof,
    });
    emit!(PreflightProofSet {
        job: job_key,
        policy,
        refusal_code,
        proof_timestamp,
    });
    Ok(())
}
