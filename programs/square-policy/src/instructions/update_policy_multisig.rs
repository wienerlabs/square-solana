use anchor_lang::prelude::*;
use crate::state::{OperatorAccount, PolicyAccount};
use super::update_policy::PolicyRegistryError;
use super::set_multisig::{SQUADS_V4_PROGRAM_ID, derive_squads_vault};

#[derive(Accounts)]
pub struct UpdatePolicyMultisig<'info> {
    #[account(
        mut,
        seeds = [b"policy", operator_account.key().as_ref(), &policy_account.policy_id],
        bump = policy_account.bump,
        constraint = policy_account.active @ PolicyRegistryError::PolicyInactive,
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    #[account(
        seeds = [b"operator", operator_account.authority.as_ref()],
        bump = operator_account.bump,
        constraint = operator_account.multisig == Some(multisig_signer.key()) @ MultisigUpdateError::UnauthorizedMultisig,
    )]
    pub operator_account: Account<'info, OperatorAccount>,

    /// The Squads v4 multisig account.
    /// CHECK: Verified below to be owned by the Squads v4 program.
    #[account(
        constraint = squads_multisig.owner == &SQUADS_V4_PROGRAM_ID
            @ MultisigUpdateError::InvalidSquadsProgram
    )]
    pub squads_multisig: UncheckedAccount<'info>,

    /// Squads vault PDA (the actual signer, derived from squads_multisig)
    pub multisig_signer: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdatePolicyMultisig>,
    new_merkle_root: [u8; 32],
    new_policy_data_hash: [u8; 32],
    vault_index: u8,
) -> Result<()> {
    // Verify the signer is the vault PDA derived from the Squads multisig
    let squads_key = ctx.accounts.squads_multisig.key();
    let (expected_vault, _bump) = derive_squads_vault(&squads_key, vault_index);
    require!(
        ctx.accounts.multisig_signer.key() == expected_vault,
        MultisigUpdateError::InvalidVaultPDA
    );

    let policy = &mut ctx.accounts.policy_account;
    let clock = Clock::get()?;

    policy.merkle_root = new_merkle_root;
    policy.policy_data_hash = new_policy_data_hash;
    policy.version = policy.version.checked_add(1).unwrap();
    policy.updated_at = clock.unix_timestamp;

    msg!(
        "Policy updated via Squads multisig to version {}, vault={}",
        policy.version,
        ctx.accounts.multisig_signer.key()
    );
    Ok(())
}

#[error_code]
pub enum MultisigUpdateError {
    #[msg("Signer is not the authorized multisig for this operator")]
    UnauthorizedMultisig,
    #[msg("Account is not owned by the Squads v4 program")]
    InvalidSquadsProgram,
    #[msg("Signer does not match the vault PDA derived from the Squads multisig")]
    InvalidVaultPDA,
}
