//! square_policy — interface contract v0.1.0 (BC-44).
//!
//! Bodiless stub: every instruction returns `PolicyError::NotImplemented`. The real program lives in
//! `programs/square-policy` (BC-05 migration from Aperture policy-registry, BC-17 commitment + public
//! daily ceiling, BC-18 buyer root). Policy contents never go on chain: only a salted Poseidon
//! commitment and the public daily ceiling.
//!
//! Authority model: every institution instruction is signed by `authority`. Before a multisig is
//! bound that is the institution key (`owner_key`); after `set_institution_multisig` it is only the
//! bound Squads vault PDA (signed through a Squads vault transaction) — the key alone no longer
//! suffices. There are no separate `*_multisig` instructions.
//!
//! Jobs snapshot the policy (commitment, daily ceiling, version) at `create_job`; `update_policy` and
//! `deactivate_policy` affect only jobs created afterwards.
#![allow(unused_variables, deprecated, clippy::too_many_arguments)]

use anchor_lang::prelude::*;

// Source program address (Aperture policy-registry). New Square program IDs are assigned in BC-09.
declare_id!("FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU");

pub const INSTITUTION_NAME_MAX_LEN: usize = 64;

#[constant]
pub const INSTITUTION_SEED: &[u8] = b"institution";
#[constant]
pub const POLICY_SEED: &[u8] = b"policy";

#[program]
pub mod square_policy_contract {
    use super::*;

    /// Creates the institution account for `authority` (which becomes `owner_key`).
    pub fn init_institution(ctx: Context<InitInstitution>, name: String) -> Result<()> {
        not_implemented()
    }

    /// Binds (or, signed by the current vault, rebinds) a Squads v4 multisig. Afterwards only its
    /// vault PDA (`vault_index`) may sign as authority.
    pub fn set_institution_multisig(
        ctx: Context<InstitutionAuthority>,
        multisig: Pubkey,
        vault_index: u8,
    ) -> Result<()> {
        not_implemented()
    }

    /// Flow step 1: commits a spending policy. Only the salted Poseidon commitment and the public
    /// daily ceiling (settlement-mint atomic units) are stored.
    pub fn set_policy(
        ctx: Context<SetPolicy>,
        policy_id: [u8; 32],
        commitment: [u8; 32],
        daily_ceiling: u64,
    ) -> Result<()> {
        not_implemented()
    }

    /// Replaces the commitment and/or daily ceiling and increments `version`. Existing jobs keep the
    /// snapshot taken at `create_job`.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        commitment: [u8; 32],
        daily_ceiling: u64,
    ) -> Result<()> {
        not_implemented()
    }

    /// Flow step 5 (institution side): publishes the root of the salted approved-buyer list.
    /// Leaf = sha256(buyer_pubkey || leaf_salt); escrow `buy_claim` checks a Merkle proof against the
    /// current root. An all-zero root means "no buyer restriction".
    pub fn set_buyer_root(ctx: Context<UpdatePolicy>, buyer_root: [u8; 32]) -> Result<()> {
        not_implemented()
    }

    /// Deactivates a policy: no new jobs can reference it. Existing jobs settle against their snapshot.
    pub fn deactivate_policy(ctx: Context<UpdatePolicy>) -> Result<()> {
        not_implemented()
    }
}

fn not_implemented() -> Result<()> {
    err!(PolicyError::NotImplemented)
}

// ------------------------------------------------------------------ accounts (contexts)

#[derive(Accounts)]
pub struct InitInstitution<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Institution::INIT_SPACE,
        seeds = [INSTITUTION_SEED, authority.key().as_ref()],
        bump
    )]
    pub institution: Account<'info, Institution>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InstitutionAuthority<'info> {
    /// `owner_key` while no multisig is bound, afterwards only `multisig_vault`.
    pub authority: Signer<'info>,
    #[account(mut, seeds = [INSTITUTION_SEED, institution.owner_key.as_ref()], bump = institution.bump)]
    pub institution: Account<'info, Institution>,
}

#[derive(Accounts)]
#[instruction(policy_id: [u8; 32])]
pub struct SetPolicy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// `owner_key` while no multisig is bound, afterwards only `multisig_vault`.
    pub authority: Signer<'info>,
    #[account(mut, seeds = [INSTITUTION_SEED, institution.owner_key.as_ref()], bump = institution.bump)]
    pub institution: Account<'info, Institution>,
    #[account(
        init,
        payer = payer,
        space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, institution.key().as_ref(), policy_id.as_ref()],
        bump
    )]
    pub policy: Account<'info, Policy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    /// `owner_key` while no multisig is bound, afterwards only `multisig_vault`.
    pub authority: Signer<'info>,
    #[account(seeds = [INSTITUTION_SEED, institution.owner_key.as_ref()], bump = institution.bump)]
    pub institution: Account<'info, Institution>,
    #[account(
        mut,
        seeds = [POLICY_SEED, institution.key().as_ref(), policy.policy_id.as_ref()],
        bump = policy.bump,
        has_one = institution
    )]
    pub policy: Account<'info, Policy>,
}

// ------------------------------------------------------------------ state

/// seeds = ["institution", owner_key]
#[account]
#[derive(InitSpace)]
pub struct Institution {
    /// The key the institution was created with; part of the PDA seeds, never changes.
    pub owner_key: Pubkey,
    pub policy_count: u32,
    pub created_at: i64,
    pub bump: u8,
    #[max_len(64)]
    pub name: String,
    /// Squads v4 multisig bound with `set_institution_multisig`.
    pub multisig: Option<Pubkey>,
    /// Squads vault PDA that is the sole authority once set (derived from `multisig` + vault index).
    pub multisig_vault: Option<Pubkey>,
}

/// seeds = ["policy", institution, policy_id]
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub institution: Pubkey,
    pub policy_id: [u8; 32],
    /// Salted Poseidon commitment of the policy (the policy itself stays off chain).
    pub commitment: [u8; 32],
    /// Public daily spending ceiling in settlement-mint atomic units (USDC: 6 decimals).
    pub daily_ceiling: u64,
    /// Root of the salted approved-buyer Merkle tree; all zeros = unrestricted.
    pub buyer_root: [u8; 32],
    pub version: u32,
    pub active: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

// ------------------------------------------------------------------ events

#[event]
pub struct InstitutionCreated {
    pub institution: Pubkey,
    pub owner_key: Pubkey,
    pub name: String,
}

#[event]
pub struct InstitutionMultisigSet {
    pub institution: Pubkey,
    pub multisig: Pubkey,
    pub multisig_vault: Pubkey,
}

#[event]
pub struct PolicyCommitted {
    pub policy: Pubkey,
    pub institution: Pubkey,
    pub policy_id: [u8; 32],
    pub commitment: [u8; 32],
    pub daily_ceiling: u64,
    pub version: u32,
}

#[event]
pub struct PolicyUpdated {
    pub policy: Pubkey,
    pub commitment: [u8; 32],
    pub daily_ceiling: u64,
    pub version: u32,
}

#[event]
pub struct BuyerRootCommitted {
    pub policy: Pubkey,
    pub buyer_root: [u8; 32],
}

#[event]
pub struct PolicyDeactivated {
    pub policy: Pubkey,
}

// ------------------------------------------------------------------ errors

/// Codes start at 6000 in every Square program; clients map errors by (program id, code).
/// (`#[error_code(offset)]` is not used: Anchor 0.31 IDLs ignore it.)
#[error_code]
pub enum PolicyError {
    #[msg("Signer is not the institution's current authority")]
    Unauthorized,
    #[msg("Institution name exceeds 64 bytes")]
    NameTooLong,
    #[msg("Policy is not active")]
    PolicyInactive,
    #[msg("Daily ceiling must be greater than zero")]
    InvalidDailyCeiling,
    #[msg("Multisig vault does not match the Squads v4 derivation")]
    InvalidMultisigVault,
    /// Stub-only; always the last variant so removing it never shifts the contract error codes.
    #[msg("Interface contract stub: not implemented")]
    NotImplemented,
}
