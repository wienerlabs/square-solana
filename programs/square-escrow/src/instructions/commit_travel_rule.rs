use anchor_lang::prelude::*;
use square_common::seeds::JOB_SEED;
use square_common::travel_rule;

use crate::errors::EscrowError;
use crate::state::{Job, JobStatus, SettlementRail};
use crate::TravelRuleCommitted;

/// Kurumun job üzerindeki talimatı: imzacı job'u açan kurum (anahtar ya da Squads vault'u).
#[derive(Accounts)]
pub struct InstitutionJob<'info> {
    pub institution: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = institution @ EscrowError::Unauthorized
    )]
    pub job: Box<Account<'info, Job>>,
}

pub fn handler(ctx: Context<InstitutionJob>, commitment: [u8; 32]) -> Result<()> {
    let job = &mut ctx.accounts.job;
    // Commitment fonlama transferine bağlanır; fiat işte zincirde fonlama yoktur (ADR 0024).
    require!(
        job.rail == SettlementRail::Escrow,
        EscrowError::RailMismatch
    );
    // Fonlamadan sonra commitment değişmez: fonlanan iş, fonlandığı andaki kayda bağlı kalır (ADR 0015).
    require!(job.status == JobStatus::Open, EscrowError::InvalidStatus);
    // Sıfır "commitment yok" demektir; bağlanamaz.
    require!(
        travel_rule::is_bound(&commitment),
        EscrowError::TravelRuleCommitmentRequired
    );
    job.travel_rule_commitment = commitment;
    emit!(TravelRuleCommitted {
        job: job.key(),
        commitment,
    });
    Ok(())
}
