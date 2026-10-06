use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use square_common::release::ReleaseFacts;
use square_common::seeds::{
    BOND_SEED, CLAIM_SEED, CONFIG_SEED, ESCROW_AUTHORITY_SEED, JOB_SEED, RELEASE_PROOF_SEED,
    REPUTATION_SEED, VALIDATION_SEED, VAULT_SEED, VERIFIER_CONFIG_SEED,
};

use crate::dispute;
use crate::errors::EscrowError;
use crate::linked;
use crate::release_gate::{self, Gate};
use crate::settlement::{self, JobSigner};
use crate::state::{
    AgentReputation, DisputeResolution, EscrowConfig, Job, JobStatus, ValidationOutcome,
    ValidationRecord,
};
use crate::{
    DisputeResolved, ReleaseRefused, ReleaseVerified, ReputationRecorded, ValidationRecorded,
};

#[derive(Accounts)]
pub struct ExecuteResolution<'info> {
    /// Permissionless caller; pays rent of the reputation/validation PDAs.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = mint @ EscrowError::MintMismatch,
        has_one = rent_payer @ EscrowError::Unauthorized
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(mut, seeds = [VAULT_SEED, job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Absent for an escalation without bond.
    #[account(mut, seeds = [BOND_SEED, job.key().as_ref()], bump = job.bond_bump)]
    pub bond_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// CHECK: ["claim", job]; may be uninitialized. If Bought the buyer is the payee.
    #[account(mut, seeds = [CLAIM_SEED, job.key().as_ref()], bump)]
    pub claim_listing: UncheckedAccount<'info>,
    // Agent tarafının (alacak satıldıysa alıcının) token hesabı; kurumla aynı hesap olabilir.
    #[account(
        mut,
        dup,
        constraint = payee_token_account.mint == mint.key() @ EscrowError::MintMismatch
    )]
    pub payee_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    // İade ve kurumun bond'unun hedefi.
    #[account(
        mut,
        constraint = institution_token_account.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = institution_token_account.owner == job.institution @ EscrowError::Unauthorized
    )]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: square_registry `ScreeningRecord` ["screening", payee]; required when paying the payee.
    pub payee_screening: UncheckedAccount<'info>,
    /// CHECK: square_verifier `ReleaseProof`; consumed by the `record_release` CPI. Policy jobs only.
    #[account(
        mut,
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub release_proof: Option<UncheckedAccount<'info>>,
    /// CHECK: square_verifier `OperatorState` of the proof's institution. Policy jobs only.
    #[account(mut)]
    pub operator_state: Option<UncheckedAccount<'info>>,
    /// CHECK: square_verifier `VerifierConfig`; passed to the CPI. Policy jobs only.
    #[account(
        seeds = [VERIFIER_CONFIG_SEED],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub verifier_config: Option<UncheckedAccount<'info>>,
    /// CHECK: equals `config.verifier_program`. Policy jobs only.
    #[account(address = config.verifier_program @ EscrowError::LinkedProgramMismatch)]
    pub verifier_program: Option<UncheckedAccount<'info>>,
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
    /// CHECK: receives the vault rents; equals `job.rent_payer`.
    #[account(mut, dup)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Kararın settlement'ı: kim ne alır.
struct Payout {
    /// Agent tarafına ödenen escrow tutarı (ispat retse 0).
    agent_side: u64,
    /// Kuruma iade edilen escrow tutarı.
    refund: u64,
    bond_to_agent_side: u64,
    bond_returned: u64,
    /// Agent tarafına bir şey ödenecekse kapının kararı; `None` = agent tarafına escrow ödenmez.
    gate: Option<Gate>,
}

impl Payout {
    fn pays_payee(&self) -> bool {
        self.agent_side > 0 || self.bond_to_agent_side > 0
    }
}

fn record_on_verifier(accounts: &ExecuteResolution, escrow_authority_bump: u8) -> Result<()> {
    let missing = || error!(EscrowError::InvalidReleaseProof);
    release_gate::record_release(
        &accounts
            .verifier_program
            .as_ref()
            .ok_or_else(missing)?
            .to_account_info(),
        &accounts.escrow_authority.to_account_info(),
        &accounts
            .verifier_config
            .as_ref()
            .ok_or_else(missing)?
            .to_account_info(),
        &accounts
            .release_proof
            .as_ref()
            .ok_or_else(missing)?
            .to_account_info(),
        &accounts
            .operator_state
            .as_ref()
            .ok_or_else(missing)?
            .to_account_info(),
        escrow_authority_bump,
    )
}

pub fn handler(ctx: Context<ExecuteResolution>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job_key = ctx.accounts.job.key();
    let job: Job = (**ctx.accounts.job).clone();
    require!(
        job.status == JobStatus::Resolved,
        EscrowError::ResolutionNotDecided
    );
    let resolution = job.dispute.resolution;
    let (awarded, slash_bond) = dispute::agent_side(&resolution, job.amount)?;

    let listing = settlement::read_listing(&ctx.accounts.claim_listing, &job_key)?;
    let (payee, sold) = settlement::payee(&job, listing.as_ref());
    // Agent tarafına giden tutar `finalize_payment`'le aynı kapıdan geçer, keeper ücreti yoktur
    // (program arayüzü §8, açık nokta 3). Kesin ret tutarı kuruma iade eder; ispat yoksa ya da ret
    // geçiciyse escrow bekler.
    let gate = if awarded > 0 {
        let facts = ReleaseFacts {
            payee,
            net_amount: awarded,
            mint: job.mint,
        };
        Some(release_gate::decide(
            &job_key,
            job.policy,
            ctx.accounts.release_proof.as_ref().map(|a| a.as_ref()),
            ctx.accounts.operator_state.as_ref().map(|a| a.as_ref()),
            &ctx.accounts.config.verifier_program,
            &facts,
            now,
        )?)
    } else {
        None
    };
    let agent_side = match gate {
        Some(g) if g.pays_agent_side() => awarded,
        _ => 0,
    };
    // Bond bir cezadır, kapıdan geçmez: FavorAgent'ta agent tarafına kesilir, diğer kararlarda kuruma
    // (bond'lu dispute'u yalnızca kurum açar) döner.
    let bond = job.dispute.bond;
    let payout = Payout {
        agent_side,
        refund: job.amount - agent_side,
        bond_to_agent_side: if slash_bond { bond } else { 0 },
        bond_returned: if slash_bond { 0 } else { bond },
        gate,
    };
    if payout.pays_payee() {
        if ctx.accounts.payee_token_account.owner != payee {
            return if sold {
                err!(EscrowError::ClaimListingRequired)
            } else {
                err!(EscrowError::AgentMismatch)
            };
        }
        // Payee'nin kaydı temiz ve taze değilse ödeme bekler, iade yapılmaz (program arayüzü §8, 5).
        linked::require_clear_screening(
            &ctx.accounts.payee_screening,
            &ctx.accounts.config.registry_program,
            &payee,
            now,
        )?;
    }

    move_funds(ctx.accounts, &job, &payout)?;
    if job.policy.is_some() && payout.gate.is_some() {
        record_on_verifier(ctx.accounts, ctx.bumps.escrow_authority)?;
    }
    if let Some(listing) = listing {
        settlement::settle_listing(&ctx.accounts.claim_listing, listing, agent_side > 0)?;
    }

    let bumps = (ctx.bumps.agent_reputation, ctx.bumps.validation_record);
    record_outcome(
        ctx.accounts,
        bumps,
        &job,
        job_key,
        &resolution,
        &payout,
        now,
    )?;
    emit!(DisputeResolved {
        job: job_key,
        resolution,
        agent_side_amount: payout.agent_side,
        institution_refund: payout.refund,
        bond_to_agent_side: payout.bond_to_agent_side,
        bond_returned: payout.bond_returned,
    });
    match payout.gate {
        Some(Gate::NoGate) => emit!(ReleaseVerified {
            job: job_key,
            payee,
            net_amount: agent_side,
            release_proof: None,
        }),
        Some(Gate::Verified { release_proof }) => emit!(ReleaseVerified {
            job: job_key,
            payee,
            net_amount: agent_side,
            release_proof: Some(release_proof),
        }),
        Some(Gate::Refused {
            release_proof,
            refusal_code,
        }) => emit!(ReleaseRefused {
            job: job_key,
            refusal_code,
            refunded_amount: awarded,
            release_proof,
        }),
        None => {}
    }
    Ok(())
}

/// Escrow ve bond aktarımları; vault'lara sonradan gelen fazlası kuruma döner, böylece ikisi de kapanır.
fn move_funds(accounts: &ExecuteResolution, job: &Job, payout: &Payout) -> Result<()> {
    let signer = JobSigner::new(job);
    let job_info = accounts.job.to_account_info();
    let token_program = &accounts.token_program;
    let mint = &accounts.mint;
    let vault = &accounts.vault;
    let payee = &accounts.payee_token_account;
    let institution = &accounts.institution_token_account;

    settlement::transfer(
        &signer,
        token_program,
        vault,
        mint,
        payee,
        &job_info,
        payout.agent_side,
    )?;
    let surplus = vault.amount.saturating_sub(job.amount);
    let refund = payout
        .refund
        .checked_add(surplus)
        .ok_or(EscrowError::MathOverflow)?;
    settlement::transfer(
        &signer,
        token_program,
        vault,
        mint,
        institution,
        &job_info,
        refund,
    )?;
    settlement::close(
        &signer,
        token_program,
        vault,
        &accounts.rent_payer,
        &job_info,
    )?;

    if job.dispute.bond > 0 {
        let bond_vault = accounts
            .bond_vault
            .as_ref()
            .ok_or(EscrowError::InvalidStatus)?;
        let bond_surplus = bond_vault.amount.saturating_sub(job.dispute.bond);
        settlement::transfer(
            &signer,
            token_program,
            bond_vault,
            mint,
            payee,
            &job_info,
            payout.bond_to_agent_side,
        )?;
        let returned = payout
            .bond_returned
            .checked_add(bond_surplus)
            .ok_or(EscrowError::MathOverflow)?;
        settlement::transfer(
            &signer,
            token_program,
            bond_vault,
            mint,
            institution,
            &job_info,
            returned,
        )?;
        settlement::close(
            &signer,
            token_program,
            bond_vault,
            &accounts.rent_payer,
            &job_info,
        )?;
    }
    Ok(())
}

/// İtibar (dispute her zaman sayılır; ödeme varsa tamamlanan iş, FavorInstitution başarısız iş),
/// validation kaydı ve job'un son durumu.
fn record_outcome(
    accounts: &mut ExecuteResolution,
    (reputation_bump, validation_bump): (u8, u8),
    job: &Job,
    job_key: Pubkey,
    resolution: &DisputeResolution,
    payout: &Payout,
    now: i64,
) -> Result<()> {
    let paid = payout.agent_side > 0;
    let reputation = &mut accounts.agent_reputation;
    if reputation.agent_record == Pubkey::default() {
        reputation.agent_record = job.agent_record;
        reputation.bump = reputation_bump;
        reputation.first_job_at = now;
    }
    let bump = |n: u64| n.checked_add(1).ok_or(EscrowError::MathOverflow);
    reputation.jobs_disputed = bump(reputation.jobs_disputed)?;
    if paid {
        reputation.jobs_completed = bump(reputation.jobs_completed)?;
        reputation.total_earned = reputation
            .total_earned
            .checked_add(payout.agent_side)
            .ok_or(EscrowError::MathOverflow)?;
    }
    if *resolution == DisputeResolution::FavorInstitution {
        reputation.jobs_failed = bump(reputation.jobs_failed)?;
    }
    reputation.last_job_at = now;
    emit!(ReputationRecorded {
        agent_record: job.agent_record,
        job: job_key,
        jobs_completed: reputation.jobs_completed,
        jobs_failed: reputation.jobs_failed,
        jobs_disputed: reputation.jobs_disputed,
        total_earned: reputation.total_earned,
    });

    let (outcome, refusal_code) = match payout.gate {
        None => (ValidationOutcome::NoPayout, 0),
        Some(Gate::NoGate) => (ValidationOutcome::NoGate, 0),
        Some(Gate::Verified { .. }) => (ValidationOutcome::Verified, 0),
        Some(Gate::Refused { refusal_code, .. }) => (ValidationOutcome::Refused, refusal_code),
    };
    accounts.validation_record.set_inner(ValidationRecord {
        job: job_key,
        agent_record: job.agent_record,
        outcome,
        refusal_code,
        recorded_at: now,
        bump: validation_bump,
        policy: job.policy,
        release_proof: payout.gate.and_then(Gate::release_proof),
    });
    emit!(ValidationRecorded {
        job: job_key,
        agent_record: job.agent_record,
        outcome,
        refusal_code,
    });

    let job_account = &mut accounts.job;
    job_account.status = if paid {
        JobStatus::Released
    } else {
        JobStatus::Refunded
    };
    job_account.settled_at = now;
    job_account.dispute.closed_at = now;
    Ok(())
}
