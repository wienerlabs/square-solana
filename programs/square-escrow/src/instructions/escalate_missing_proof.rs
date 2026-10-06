use anchor_lang::prelude::*;
use square_common::account_read;
use square_common::contract::square_verifier_contract::accounts::ReleaseProof;
use square_common::contract::square_verifier_contract::types::ReleaseVerdict;
use square_common::release::is_final_refusal;
use square_common::seeds::{CONFIG_SEED, JOB_SEED, RELEASE_PROOF_SEED};
use square_common::time::day_start;

use crate::dispute;
use crate::errors::EscrowError;
use crate::state::{DisputeInfo, EscrowConfig, Job};
use crate::{DisputeRaised, MissingProofEscalated};

#[derive(Accounts)]
pub struct EscalateMissingProof<'info> {
    /// Must equal `job.agent_wallet`.
    pub agent: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        constraint = job.agent_wallet == agent.key() @ EscrowError::AgentMismatch
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_verifier `ReleaseProof` ["release_proof", job]; usually missing.
    // Bugün işi kapatabilecek bir ispat varsa başvuru reddedilir.
    #[account(
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub release_proof: UncheckedAccount<'info>,
}

/// Bağlı ispat bugün işi kapatabiliyorsa (`finalize_payment` ödeyebilir ya da iade edebilir) agent'ın
/// başvurusuna gerek yoktur. İspat yoksa, ret geçiciyse ya da ispat başka bir UTC gününde
/// değerlendirildiyse (bayat; kurum yenilemezse escrow süresiz bekler) dispute açılabilir (ADR 0016).
fn proof_can_settle(info: &AccountInfo, verifier_program: &Pubkey, now: i64) -> Result<bool> {
    if info.data_is_empty() {
        return Ok(false);
    }
    let proof: ReleaseProof = account_read::read_owned(info, verifier_program)
        .map_err(|_| error!(EscrowError::InvalidReleaseProof))?;
    if proof.consumed || day_start(proof.proof_timestamp) != day_start(now) {
        return Ok(false);
    }
    Ok(match proof.verdict {
        ReleaseVerdict::Compliant => true,
        ReleaseVerdict::Refused => is_final_refusal(proof.refusal_code, proof.daily_spent_before),
    })
}

pub fn handler(ctx: Context<EscalateMissingProof>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let job = &accounts.job;
    let params = &accounts.config.params;
    dispute::require_can_open(job)?;
    // İspat kapısı yalnızca policy'li işte vardır; policy'siz iş `finalize_payment` ile kapanır.
    require!(job.policy.is_some(), EscrowError::InvalidStatus);
    // Bekleme süresi teslimin challenge penceresinden, önceki dispute lapse olduysa da onun kapanışından
    // sayılır; açık ya da karara bağlanmış bir dispute'un üstüne başvuru açılmaz.
    let since = if job.dispute.raised_at == 0 {
        job.challenge_end
    } else {
        require!(job.dispute.lapsed, EscrowError::DisputeAlreadyRaised);
        job.dispute.closed_at.max(job.challenge_end)
    };
    let ready_at = since
        .checked_add(params.proof_timeout_secs)
        .ok_or(EscrowError::MathOverflow)?;
    require!(now >= ready_at, EscrowError::ProofTimeoutNotReached);
    require!(
        !proof_can_settle(
            &accounts.release_proof,
            &accounts.config.verifier_program,
            now
        )?,
        EscrowError::InvalidStatus
    );

    let agent_wallet = accounts.agent.key();
    let set_version = accounts.config.arbitrator_set_version;
    let deadline = dispute::deadline(now, params)?;
    let job = &mut ctx.accounts.job;
    job.status = crate::state::JobStatus::Disputed;
    job.dispute = DisputeInfo {
        challenger: agent_wallet,
        raised_at: now,
        deadline,
        arbitrator_set_version: set_version,
        ..DisputeInfo::default()
    };
    let job_key = job.key();
    emit!(MissingProofEscalated {
        job: job_key,
        agent_wallet,
    });
    emit!(DisputeRaised {
        job: job_key,
        challenger: agent_wallet,
        bond: 0,
        reason_hash: [0; 32],
        deadline,
    });
    Ok(())
}
