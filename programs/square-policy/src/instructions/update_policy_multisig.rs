use anchor_lang::prelude::*;
use crate::state::{OperatorAccount, PolicyAccount};
use super::update_policy::PolicyRegistryError;

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

    /// Squads multisig signer (proposal executor)
    pub multisig_signer: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdatePolicyMultisig>,
    new_merkle_root: [u8; 32],
    new_policy_data_hash: [u8; 32],
) -> Result<()> {
    let policy = &mut ctx.accounts.policy_account;
    let clock = Clock::get()?;

    policy.merkle_root = new_merkle_root;
    policy.policy_data_hash = new_policy_data_hash;
    policy.version = policy.version.checked_add(1).unwrap();
    policy.updated_at = clock.unix_timestamp;

    msg!("Policy updated via multisig to version {}", policy.version);
    Ok(())
}

#[error_code]
pub enum MultisigUpdateError {
    #[msg("Signer is not the authorized multisig for this operator")]
    UnauthorizedMultisig,
}
