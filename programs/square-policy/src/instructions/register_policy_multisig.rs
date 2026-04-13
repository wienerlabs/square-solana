use anchor_lang::prelude::*;
use crate::state::{OperatorAccount, PolicyAccount};
use super::set_multisig::{SQUADS_V4_PROGRAM_ID, derive_squads_vault};

#[derive(Accounts)]
#[instruction(policy_id: [u8; 32])]
pub struct RegisterPolicyMultisig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PolicyAccount::INIT_SPACE,
        seeds = [b"policy", operator_account.key().as_ref(), &policy_id],
        bump,
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    #[account(
        mut,
        seeds = [b"operator", operator_account.authority.as_ref()],
        bump = operator_account.bump,
        constraint = operator_account.multisig == Some(multisig_signer.key()) @ MultisigError::UnauthorizedMultisig,
    )]
    pub operator_account: Account<'info, OperatorAccount>,

    /// The Squads v4 multisig account.
    /// CHECK: Verified below to be owned by the Squads v4 program.
    #[account(
        constraint = squads_multisig.owner == &SQUADS_V4_PROGRAM_ID
            @ MultisigError::InvalidSquadsProgram
    )]
    pub squads_multisig: UncheckedAccount<'info>,

    /// Squads vault PDA (the actual signer, derived from squads_multisig)
    pub multisig_signer: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterPolicyMultisig>,
    policy_id: [u8; 32],
    merkle_root: [u8; 32],
    policy_data_hash: [u8; 32],
    vault_index: u8,
) -> Result<()> {
    // Verify the signer is the vault PDA derived from the Squads multisig
    let squads_key = ctx.accounts.squads_multisig.key();
    let (expected_vault, _bump) = derive_squads_vault(&squads_key, vault_index);
    require!(
        ctx.accounts.multisig_signer.key() == expected_vault,
        MultisigError::InvalidVaultPDA
    );

    let policy = &mut ctx.accounts.policy_account;
    let operator = &mut ctx.accounts.operator_account;
    let clock = Clock::get()?;

    policy.operator = operator.key();
    policy.policy_id = policy_id;
    policy.merkle_root = merkle_root;
    policy.policy_data_hash = policy_data_hash;
    policy.version = 1;
    policy.active = true;
    policy.created_at = clock.unix_timestamp;
    policy.updated_at = clock.unix_timestamp;
    policy.bump = ctx.bumps.policy_account;

    operator.policy_count = operator.policy_count.checked_add(1).unwrap();

    msg!(
        "Policy registered via Squads multisig: version {}, vault={}",
        policy.version,
        ctx.accounts.multisig_signer.key()
    );
    Ok(())
}

#[error_code]
pub enum MultisigError {
    #[msg("Signer is not the authorized multisig for this operator")]
    UnauthorizedMultisig,
    #[msg("Account is not owned by the Squads v4 program")]
    InvalidSquadsProgram,
    #[msg("Signer does not match the vault PDA derived from the Squads multisig")]
    InvalidVaultPDA,
}
