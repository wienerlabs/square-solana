use anchor_lang::prelude::*;
use square_common::release::ReleaseFacts;
use square_common::seeds::{
    CONFIG_SEED, ESCROW_AUTHORITY_SEED, JOB_SEED, RELEASE_PROOF_SEED, REPUTATION_SEED,
    VALIDATION_SEED, VERIFIER_CONFIG_SEED,
};

use crate::errors::EscrowError;
use crate::release_gate::{self, Gate};
use crate::settlement;
use crate::state::{
    AgentReputation, EscrowConfig, Job, JobStatus, SettlementRail, ValidationRecord,
};
use crate::{Finalized, ReleaseVerified};

#[derive(Accounts)]
pub struct FinalizeFiatPayment<'info> {
    /// Permissionless caller; pays rent of the reputation/validation PDAs. No keeper fee (no vault).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_verifier `ReleaseProof` written by `verify_mpp_payment_proof`; consumed by the
    /// `record_release` CPI.
    #[account(
        mut,
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub release_proof: UncheckedAccount<'info>,
    /// CHECK: square_verifier `OperatorState` ["operator_state", release_proof.institution]; checked
    /// for freshness and advanced by the CPI.
    #[account(mut)]
    pub operator_state: UncheckedAccount<'info>,
    /// CHECK: square_verifier `VerifierConfig`; passed to the CPI.
    #[account(
        seeds = [VERIFIER_CONFIG_SEED],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub verifier_config: UncheckedAccount<'info>,
    /// CHECK: equals `config.verifier_program`.
    #[account(address = config.verifier_program @ EscrowError::LinkedProgramMismatch)]
    pub verifier_program: UncheckedAccount<'info>,
    /// CHECK: PDA ["escrow_authority"]; CPI signer for `record_release`, holds no data or funds.
    #[account(seeds = [ESCROW_AUTHORITY_SEED], bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AgentReputation::INIT_SPACE,
        seeds = [REPUTATION_SEED, job.agent_record.as_ref()],
        bump
    )]
    pub agent_reputation: Box<Account<'info, AgentReputation>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ValidationRecord::INIT_SPACE,
        seeds = [VALIDATION_SEED, job.key().as_ref()],
        bump
    )]
    pub validation_record: Box<Account<'info, ValidationRecord>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FinalizeFiatPayment>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job_key = ctx.accounts.job.key();
    let job: Job = (**ctx.accounts.job).clone();
    require!(job.rail == SettlementRail::Fiat, EscrowError::RailMismatch);
    // Ödeme Stripe'ta yapıldı ve kurumun ödemesi teslimi kabulüdür: challenge penceresi ve dispute yok
    // (ADR 0024).
    require!(
        job.status == JobStatus::Delivered,
        EscrowError::InvalidStatus
    );

    // Ödenen tutar işin tamamıdır (keeper ücreti yok); payee agent cüzdanı (fiat işin alacağı satılmaz).
    let facts = ReleaseFacts {
        payee: job.agent_wallet,
        net_amount: job.amount,
        mint: job.mint,
    };
    let accounts = &ctx.accounts;
    let gate = release_gate::decide(
        &job_key,
        job.policy,
        Some(accounts.release_proof.as_ref()),
        Some(accounts.operator_state.as_ref()),
        &accounts.config.verifier_program,
        &facts,
        now,
    )?;
    // MPP ispatı yalnızca uyumlu yazılır; fiat işte ret ispatı bağlanamaz.
    let Gate::Verified { release_proof } = gate else {
        return err!(EscrowError::InvalidReleaseProof);
    };
    release_gate::record_release(
        &accounts.verifier_program,
        &accounts.escrow_authority,
        &accounts.verifier_config,
        &accounts.release_proof,
        &accounts.operator_state,
        ctx.bumps.escrow_authority,
    )?;

    let payer = ctx.accounts.payer.key();
    let accounts = &mut *ctx.accounts;
    settlement::record_outcome(
        settlement::Outcome {
            reputation: &mut accounts.agent_reputation,
            validation_record: &mut accounts.validation_record,
            job_account: &mut accounts.job,
            bumps: (ctx.bumps.agent_reputation, ctx.bumps.validation_record),
        },
        &job,
        job_key,
        gate,
        job.amount,
        now,
    )?;
    emit!(Finalized {
        job: job_key,
        keeper: payer,
        keeper_fee: 0,
    });
    emit!(ReleaseVerified {
        job: job_key,
        payee: job.agent_wallet,
        net_amount: job.amount,
        release_proof: Some(release_proof),
    });
    Ok(())
}
