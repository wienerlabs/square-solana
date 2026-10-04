use anchor_lang::prelude::*;
use square_common::seeds::{legacy, squads};
use crate::errors::PolicyRegistryError;
use crate::state::OperatorAccount;

/// Squads v4 Multisig Program ID (Devnet & Mainnet)
pub const SQUADS_V4_PROGRAM_ID: Pubkey =
    pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

/// Derives the Squads v4 vault PDA from a multisig account.
/// Seeds: ["multisig", multisig_key, "vault", vault_index]
pub fn derive_squads_vault(multisig_key: &Pubkey, vault_index: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            squads::MULTISIG_SEED,
            multisig_key.as_ref(),
            squads::VAULT_SEED,
            &[vault_index],
        ],
        &SQUADS_V4_PROGRAM_ID,
    )
}

#[derive(Accounts)]
pub struct SetMultisig<'info> {
    #[account(
        mut,
        seeds = [legacy::OPERATOR_SEED, authority.key().as_ref()],
        bump = operator_account.bump,
        has_one = authority,
    )]
    pub operator_account: Account<'info, OperatorAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// The Squads v4 multisig account.
    /// CHECK: Verified below to be owned by the Squads v4 program.
    #[account(
        constraint = squads_multisig.owner == &SQUADS_V4_PROGRAM_ID
            @ PolicyRegistryError::InvalidSquadsProgram
    )]
    pub squads_multisig: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<SetMultisig>, vault_index: u8) -> Result<()> {
    let squads_key = ctx.accounts.squads_multisig.key();

    // Verify the Squads multisig account has data (is initialized)
    require!(
        !ctx.accounts.squads_multisig.data_is_empty(),
        PolicyRegistryError::MultisigNotInitialized
    );

    // Derive the vault PDA from the Squads multisig
    let (vault_pda, _bump) = derive_squads_vault(&squads_key, vault_index);

    // Store the vault PDA as the authorized multisig signer
    let operator = &mut ctx.accounts.operator_account;
    operator.multisig = Some(vault_pda);

    msg!(
        "Squads multisig set: multisig={}, vault={}, vault_index={}",
        squads_key,
        vault_pda,
        vault_index
    );
    Ok(())
}

