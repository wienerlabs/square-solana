//! Account contexts of the square_escrow interface contract.
//!
//! Rent: role signers never pay rent, except permissionless callers (`keeper`, `execute_resolution`
//! payer) for the reputation / validation PDAs they create, and the admin for the config. Closed
//! accounts return rent to the recorded `rent_payer`.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::state::*;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Must be the program upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + EscrowConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::SquareEscrowContract>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Box<Account<'info, EscrowConfig>>,
}

#[derive(Accounts)]
#[instruction(spec_hash: [u8; 32])]
pub struct CreateJob<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Institution wallet or its Squads vault; funds the job and receives refunds.
    pub institution: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    /// CHECK: square_registry `AgentRecord` (owner = `config.registry_program`, status Active).
    pub agent_record: UncheckedAccount<'info>,
    /// CHECK: optional square_policy `Policy` (owner = `config.policy_program`, active); makes the
    /// job proof-gated and is snapshotted into the job.
    pub policy: Option<UncheckedAccount<'info>>,
    /// CHECK: square_policy `Institution` of `policy`; `institution` must be its current authority.
    pub policy_institution: Option<UncheckedAccount<'info>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Job::INIT_SPACE,
        seeds = [JOB_SEED, institution.key().as_ref(), spec_hash.as_ref()],
        bump
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, job.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = job,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.settlement_mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InstitutionJob<'info> {
    pub institution: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = institution
    )]
    pub job: Box<Account<'info, Job>>,
}

#[derive(Accounts)]
pub struct FundJob<'info> {
    pub institution: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = institution,
        has_one = mint
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(mut, seeds = [VAULT_SEED, job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = institution)]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: square_registry `ScreeningRecord` of the institution; Clear and not expired.
    #[account(
        seeds = [SCREENING_SEED, institution.key().as_ref()],
        bump,
        seeds::program = config.registry_program.key()
    )]
    pub institution_screening: UncheckedAccount<'info>,
    /// CHECK: square_registry `ScreeningRecord` of `job.agent_wallet`; Clear and not expired.
    #[account(
        seeds = [SCREENING_SEED, job.agent_wallet.as_ref()],
        bump,
        seeds::program = config.registry_program.key()
    )]
    pub agent_screening: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AgentJob<'info> {
    /// Must equal `job.agent_wallet`.
    pub agent: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = agent_record
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_registry `AgentRecord` bound to the job (owner = `config.registry_program`);
    /// `accept_job` requires status Active.
    pub agent_record: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SyncAgentWallet<'info> {
    /// Must equal `AgentRecord.owner`.
    pub agent_owner: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = agent_record
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_registry `AgentRecord` bound to the job; its current `wallet` is copied.
    pub agent_record: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ListClaim<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Seller = `job.agent_wallet`.
    pub agent: Signer<'info>,
    #[account(
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(
        init,
        payer = payer,
        space = 8 + ClaimListing::INIT_SPACE,
        seeds = [CLAIM_SEED, job.key().as_ref()],
        bump
    )]
    pub claim_listing: Box<Account<'info, ClaimListing>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyClaim<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = mint
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(
        mut,
        seeds = [CLAIM_SEED, job.key().as_ref()],
        bump = claim_listing.bump,
        has_one = job
    )]
    pub claim_listing: Box<Account<'info, ClaimListing>>,
    /// CHECK: square_policy `Policy` equal to `job.policy`; its current `buyer_root` is read.
    /// Omitted for jobs without a policy.
    pub policy: Option<UncheckedAccount<'info>>,
    /// CHECK: square_registry `ScreeningRecord` of the buyer; Clear and not expired.
    #[account(
        seeds = [SCREENING_SEED, buyer.key().as_ref()],
        bump,
        seeds::program = config.registry_program.key()
    )]
    pub buyer_screening: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = claim_listing.seller)]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelClaim<'info> {
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [CLAIM_SEED, claim_listing.job.as_ref()],
        bump = claim_listing.bump,
        has_one = seller,
        has_one = rent_payer
    )]
    pub claim_listing: Box<Account<'info, ClaimListing>>,
    /// CHECK: receives the listing rent; equals `claim_listing.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// Release path of a delivered, undisputed job.
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
        has_one = mint,
        has_one = rent_payer
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(mut, seeds = [VAULT_SEED, job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: ["claim", job]; may be uninitialized. If Bought the buyer is the payee; set to Settled.
    #[account(mut, seeds = [CLAIM_SEED, job.key().as_ref()], bump)]
    pub claim_listing: UncheckedAccount<'info>,
    /// Token account of the resolved payee (claim buyer or `job.agent_wallet`).
    #[account(mut, token::mint = mint)]
    pub payee_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Refund target of a refused release.
    #[account(mut, token::mint = mint, token::authority = job.institution)]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = keeper)]
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
    #[account(address = config.verifier_program)]
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
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub institution: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = institution,
        has_one = mint
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(
        init,
        payer = payer,
        seeds = [BOND_SEED, job.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = job,
        token::token_program = token_program
    )]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = institution)]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EscalateMissingProof<'info> {
    /// Must equal `job.agent_wallet`.
    pub agent: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_verifier `ReleaseProof`; must not exist (or not be bound to this job).
    #[account(
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub release_proof: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// One of `config.arbitrators[..arbitrator_count]`.
    pub arbitrator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
}

/// Payout of a `Resolved` dispute; same payee resolution and proof gate as `FinalizePayment`.
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
        has_one = mint,
        has_one = rent_payer
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(mut, seeds = [VAULT_SEED, job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Absent for an escalation without bond.
    #[account(mut, seeds = [BOND_SEED, job.key().as_ref()], bump = job.bond_bump)]
    pub bond_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// CHECK: ["claim", job]; may be uninitialized. Bought -> buyer is the payee (Settled or Defaulted).
    #[account(mut, seeds = [CLAIM_SEED, job.key().as_ref()], bump)]
    pub claim_listing: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint)]
    pub payee_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = job.institution)]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: square_registry `ScreeningRecord` ["screening", payee].
    pub payee_screening: UncheckedAccount<'info>,
    /// CHECK: square_verifier `ReleaseProof`. Policy jobs with an agent-side payout only.
    #[account(
        mut,
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub release_proof: Option<UncheckedAccount<'info>>,
    /// CHECK: square_verifier `OperatorState`. Policy jobs with an agent-side payout only.
    #[account(mut)]
    pub operator_state: Option<UncheckedAccount<'info>>,
    /// CHECK: square_verifier `VerifierConfig`. Policy jobs with an agent-side payout only.
    #[account(
        seeds = [VERIFIER_CONFIG_SEED],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub verifier_config: Option<UncheckedAccount<'info>>,
    /// CHECK: equals `config.verifier_program`.
    #[account(address = config.verifier_program)]
    pub verifier_program: Option<UncheckedAccount<'info>>,
    /// CHECK: PDA ["escrow_authority"]; CPI signer for `record_release`.
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
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LapseDispute<'info> {
    /// Permissionless caller.
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = mint,
        has_one = rent_payer
    )]
    pub job: Box<Account<'info, Job>>,
    /// Absent for an escalation without bond.
    #[account(mut, seeds = [BOND_SEED, job.key().as_ref()], bump = job.bond_bump)]
    pub bond_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// Bond refund target (the challenger of a bonded dispute is the institution).
    #[account(mut, token::mint = mint, token::authority = job.institution)]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: receives the bond vault rent; equals `job.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelJob<'info> {
    pub institution: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = institution,
        has_one = mint,
        has_one = rent_payer
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(mut, seeds = [VAULT_SEED, job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = institution)]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: receives the vault rent; equals `job.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
