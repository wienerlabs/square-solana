use anchor_lang::prelude::*;
use square_common::release::daily_spent_at;
use square_common::seeds::{
    ESCROW_AUTHORITY_SEED, OPERATOR_STATE_SEED, RELEASE_PROOF_SEED, VERIFIER_CONFIG_SEED,
};
use square_common::time::day_start;

use crate::errors::VerifierError;
use crate::state::{OperatorState, ReleaseProof, ReleaseVerdict, VerifierConfig};
use crate::ReleaseRecorded;

#[derive(Accounts)]
pub struct RecordRelease<'info> {
    /// PDA ["escrow_authority"] of `config.escrow_program`; signs via `invoke_signed`.
    pub escrow_authority: Signer<'info>,
    #[account(seeds = [VERIFIER_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VerifierConfig>,
    #[account(
        mut,
        seeds = [RELEASE_PROOF_SEED, release_proof.job.as_ref()],
        bump = release_proof.bump
    )]
    pub release_proof: Account<'info, ReleaseProof>,
    #[account(
        mut,
        seeds = [OPERATOR_STATE_SEED, release_proof.institution.as_ref()],
        bump = operator_state.bump
    )]
    pub operator_state: Account<'info, OperatorState>,
}

pub fn handler(ctx: Context<RecordRelease>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (escrow_authority, _) = Pubkey::find_program_address(
        &[ESCROW_AUTHORITY_SEED],
        &ctx.accounts.config.escrow_program,
    );
    require_keys_eq!(
        ctx.accounts.escrow_authority.key(),
        escrow_authority,
        VerifierError::Unauthorized
    );
    let proof = &ctx.accounts.release_proof;
    require!(!proof.consumed, VerifierError::ProofAlreadyConsumed);
    // Escrow tazeliği release'ten önce denetler (`square_common::release::check_fresh`); sayacın sahibi
    // olarak verifier, ilerletmeden önce gün ve sayaç kuralını yeniden uygular.
    let state = &ctx.accounts.operator_state;
    let spent = daily_spent_at(state.day_start_unix, state.daily_spent, now)
        .filter(|spent| {
            *spent == proof.daily_spent_before && day_start(proof.proof_timestamp) == day_start(now)
        })
        .ok_or(VerifierError::StaleProof)?;

    // Ret iadedir: ödeme yapılmadığı için sayaç ilerlemez, ispat yine tüketilir.
    let released = match proof.verdict {
        ReleaseVerdict::Compliant => proof.net_amount,
        ReleaseVerdict::Refused => 0,
    };
    let job = proof.job;
    let institution = proof.institution;
    let state = &mut ctx.accounts.operator_state;
    state.day_start_unix = day_start(now);
    state.daily_spent = spent
        .checked_add(released)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if released > 0 {
        state.total_lifetime_payments = state
            .total_lifetime_payments
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    let (daily_spent, day_start_unix) = (state.daily_spent, state.day_start_unix);
    ctx.accounts.release_proof.consumed = true;
    emit!(ReleaseRecorded {
        job,
        institution,
        net_amount: released,
        daily_spent,
        day_start_unix,
    });
    Ok(())
}
