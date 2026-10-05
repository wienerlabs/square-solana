use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use square_common::constants::BPS_DENOMINATOR;
use square_common::release::ReleaseFacts;
use square_common::seeds::{
    CLAIM_SEED, CONFIG_SEED, ESCROW_AUTHORITY_SEED, JOB_SEED, RELEASE_PROOF_SEED, REPUTATION_SEED,
    VALIDATION_SEED, VAULT_SEED, VERIFIER_CONFIG_SEED,
};

use crate::errors::EscrowError;
use crate::linked;
use crate::release_gate::{self, Gate};
use crate::state::{
    AgentReputation, ClaimListing, ClaimStatus, EscrowConfig, Job, JobStatus, ValidationOutcome,
    ValidationRecord,
};
use crate::{Finalized, ReleaseRefused, ReleaseVerified, ReputationRecorded, ValidationRecorded};

#[derive(Accounts)]
pub struct FinalizePayment<'info> {
    /// Permissionless caller; receives the keeper fee and pays rent of the reputation/validation PDAs.
    #[account(mut)]
    pub keeper: Signer<'info>,
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
    /// CHECK: ["claim", job]; may be uninitialized. If Bought the buyer is the payee; set to Settled.
    #[account(mut, seeds = [CLAIM_SEED, job.key().as_ref()], bump)]
    pub claim_listing: UncheckedAccount<'info>,
    /// Token account of the resolved payee (claim buyer or `job.agent_wallet`).
    // Keeper ya da kurum payee olabilir: aynı token hesabı birden çok rolde gelebilir (ADR 0013).
    #[account(
        mut,
        dup,
        constraint = payee_token_account.mint == mint.key() @ EscrowError::MintMismatch
    )]
    pub payee_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Refund target of a refused release.
    #[account(
        mut,
        constraint = institution_token_account.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = institution_token_account.owner == job.institution @ EscrowError::Unauthorized
    )]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        dup,
        constraint = keeper_token_account.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = keeper_token_account.owner == keeper.key() @ EscrowError::Unauthorized
    )]
    pub keeper_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: square_registry `ScreeningRecord` ["screening", payee]; Clear and fresh, else it waits.
    pub payee_screening: UncheckedAccount<'info>,
    /// CHECK: square_verifier `ReleaseProof`; written by the `record_release` CPI. Policy jobs only.
    #[account(
        mut,
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub release_proof: Option<UncheckedAccount<'info>>,
    /// CHECK: square_verifier `OperatorState` ["operator_state", release_proof.institution]; checked
    /// for freshness and written by the CPI. Policy jobs only.
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
        payer = keeper,
        space = 8 + AgentReputation::INIT_SPACE,
        seeds = [REPUTATION_SEED, job.agent_record.as_ref()],
        bump
    )]
    pub agent_reputation: Box<Account<'info, AgentReputation>>,
    #[account(
        init,
        payer = keeper,
        space = 8 + ValidationRecord::INIT_SPACE,
        seeds = [VALIDATION_SEED, job.key().as_ref()],
        bump
    )]
    pub validation_record: Box<Account<'info, ValidationRecord>>,
    /// CHECK: receives the vault rent; equals `job.rent_payer`.
    // Rent'i ödeyen keeper'ın kendisi olabilir.
    #[account(mut, dup)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Keeper ücreti: `amount × keeper_fee_bps / 10 000`, aşağı yuvarlanır.
pub fn keeper_fee(amount: u64, keeper_fee_bps: u16) -> Result<u64> {
    let fee = u128::from(amount) * u128::from(keeper_fee_bps) / u128::from(BPS_DENOMINATOR);
    u64::try_from(fee).map_err(|_| error!(EscrowError::MathOverflow))
}

/// `["claim", job]` listelemesi; hesap yoksa (alacak listelenmemiş) `None`.
fn read_listing(info: &AccountInfo, job: &Pubkey) -> Result<Option<ClaimListing>> {
    if info.data_is_empty() {
        return Ok(None);
    }
    let listing = ClaimListing::try_deserialize(&mut &info.try_borrow_data()?[..])
        .map_err(|_| error!(EscrowError::ClaimListingMismatch))?;
    require_keys_eq!(listing.job, *job, EscrowError::ClaimListingMismatch);
    Ok(Some(listing))
}

/// Settlement'ta listeleme: ödemede `Settled` (satılmışsa alıcıya ödendi, satılmamışsa satışa kapandı),
/// iadede `Defaulted` (alıcıya ödenmez).
fn settle_listing(info: &AccountInfo, listing: ClaimListing, paid: bool) -> Result<()> {
    let status = if paid {
        ClaimStatus::Settled
    } else {
        ClaimStatus::Defaulted
    };
    let settled = ClaimListing { status, ..listing };
    let mut data = info.try_borrow_mut_data()?;
    settled.try_serialize(&mut &mut data[..])
}

/// Job PDA'sının imzasıyla vault'tan `amount` aktarır (0 ise aktarım yapılmaz).
fn pay<'info>(
    accounts: &FinalizePayment<'info>,
    job: &Job,
    to: &InterfaceAccount<'info, TokenAccount>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = [job.bump];
    let seeds: &[&[u8]] = &[
        JOB_SEED,
        job.institution.as_ref(),
        job.spec_hash.as_ref(),
        &bump,
    ];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.vault.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: to.to_account_info(),
                authority: accounts.job.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        accounts.mint.decimals,
    )
}

fn close_vault(accounts: &FinalizePayment, job: &Job) -> Result<()> {
    let bump = [job.bump];
    let seeds: &[&[u8]] = &[
        JOB_SEED,
        job.institution.as_ref(),
        job.spec_hash.as_ref(),
        &bump,
    ];
    token_interface::close_account(CpiContext::new_with_signer(
        accounts.token_program.key(),
        CloseAccount {
            account: accounts.vault.to_account_info(),
            destination: accounts.rent_payer.to_account_info(),
            authority: accounts.job.to_account_info(),
        },
        &[seeds],
    ))
}

/// Ödenecek tarafın token hesabı ve screening'i: alacak satıldıysa alıcı, değilse agent cüzdanı.
fn require_payee_ready(
    accounts: &FinalizePayment,
    payee: &Pubkey,
    sold: bool,
    now: i64,
) -> Result<()> {
    if accounts.payee_token_account.owner != *payee {
        return if sold {
            err!(EscrowError::ClaimListingRequired)
        } else {
            err!(EscrowError::AgentMismatch)
        };
    }
    // Payee'nin kaydı temiz ve taze değilse ödeme bekler, iade yapılmaz (program arayüzü §8, 5).
    linked::require_clear_screening(
        &accounts.payee_screening,
        &accounts.config.registry_program,
        payee,
        now,
    )
}

/// Policy'li işte verifier'ın `record_release`'i: ispatı tüketir, uyumluysa sayacı ilerletir.
fn record_on_verifier(accounts: &FinalizePayment, escrow_authority_bump: u8) -> Result<()> {
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

pub fn handler(ctx: Context<FinalizePayment>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job_key = ctx.accounts.job.key();
    let job: Job = (**ctx.accounts.job).clone();
    require!(
        job.status == JobStatus::Delivered,
        EscrowError::InvalidStatus
    );
    require!(
        now >= job.challenge_end,
        EscrowError::ChallengePeriodNotExpired
    );

    let fee = keeper_fee(job.amount, ctx.accounts.config.params.keeper_fee_bps)?;
    let net = job.amount - fee;
    let listing = read_listing(&ctx.accounts.claim_listing, &job_key)?;
    let sold = listing
        .as_ref()
        .is_some_and(|l| matches!(l.status, ClaimStatus::Bought));
    let payee = match &listing {
        Some(l) if sold => l.buyer,
        _ => job.agent_wallet,
    };
    let facts = ReleaseFacts {
        payee,
        net_amount: net,
        mint: job.mint,
    };
    let gate = release_gate::decide(
        &job_key,
        job.policy,
        ctx.accounts.release_proof.as_ref().map(|a| a.as_ref()),
        ctx.accounts.operator_state.as_ref().map(|a| a.as_ref()),
        &ctx.accounts.config.verifier_program,
        &facts,
        now,
    )?;
    let paid = gate.pays_agent_side();
    if paid {
        require_payee_ready(ctx.accounts, &payee, sold, now)?;
    }

    // Ücret her dalda keeper'a; net payee'ye ya da (kesin retta) kuruma; vault'a sonradan gelen fazlası
    // kuruma döner, böylece vault kapanabilir.
    let accounts = &ctx.accounts;
    pay(accounts, &job, &accounts.keeper_token_account, fee)?;
    let net_target = if paid {
        &accounts.payee_token_account
    } else {
        &accounts.institution_token_account
    };
    pay(accounts, &job, net_target, net)?;
    let surplus = accounts.vault.amount.saturating_sub(job.amount);
    pay(accounts, &job, &accounts.institution_token_account, surplus)?;
    if job.policy.is_some() {
        record_on_verifier(accounts, ctx.bumps.escrow_authority)?;
    }
    close_vault(accounts, &job)?;
    if let Some(listing) = listing {
        settle_listing(&ctx.accounts.claim_listing, listing, paid)?;
    }

    let keeper = ctx.accounts.keeper.key();
    let bumps = (ctx.bumps.agent_reputation, ctx.bumps.validation_record);
    record_outcome(ctx.accounts, bumps, &job, job_key, gate, net, now)?;
    emit!(Finalized {
        job: job_key,
        keeper,
        keeper_fee: fee,
    });
    match gate {
        Gate::NoGate => emit!(ReleaseVerified {
            job: job_key,
            payee,
            net_amount: net,
            release_proof: None,
        }),
        Gate::Verified { release_proof } => emit!(ReleaseVerified {
            job: job_key,
            payee,
            net_amount: net,
            release_proof: Some(release_proof),
        }),
        Gate::Refused {
            release_proof,
            refusal_code,
        } => emit!(ReleaseRefused {
            job: job_key,
            refusal_code,
            refunded_amount: net,
            release_proof,
        }),
    }
    Ok(())
}

/// İtibar (her zaman `AgentRecord`'a, alacak satılmış olsa da; ADR 0013), validation kaydı ve job'un
/// son durumu.
fn record_outcome(
    accounts: &mut FinalizePayment,
    (reputation_bump, validation_bump): (u8, u8),
    job: &Job,
    job_key: Pubkey,
    gate: Gate,
    net: u64,
    now: i64,
) -> Result<()> {
    let paid = gate.pays_agent_side();
    let reputation = &mut accounts.agent_reputation;
    if reputation.agent_record == Pubkey::default() {
        reputation.agent_record = job.agent_record;
        reputation.bump = reputation_bump;
        reputation.first_job_at = now;
    }
    if paid {
        reputation.jobs_completed = reputation
            .jobs_completed
            .checked_add(1)
            .ok_or(EscrowError::MathOverflow)?;
        reputation.total_earned = reputation
            .total_earned
            .checked_add(net)
            .ok_or(EscrowError::MathOverflow)?;
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

    let (outcome, refusal_code) = match gate {
        Gate::NoGate => (ValidationOutcome::NoGate, 0),
        Gate::Verified { .. } => (ValidationOutcome::Verified, 0),
        Gate::Refused { refusal_code, .. } => (ValidationOutcome::Refused, refusal_code),
    };
    accounts.validation_record.set_inner(ValidationRecord {
        job: job_key,
        agent_record: job.agent_record,
        outcome,
        refusal_code,
        recorded_at: now,
        bump: validation_bump,
        policy: job.policy,
        release_proof: gate.release_proof(),
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
    Ok(())
}
