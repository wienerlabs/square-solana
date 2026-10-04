use anchor_lang::prelude::*;
use square_common::seeds::INSTITUTION_SEED;
use square_common::squads;

use crate::errors::PolicyError;
use crate::state::Institution;
use crate::InstitutionMultisigSet;

#[derive(Accounts)]
#[instruction(multisig: Pubkey)]
pub struct SetInstitutionMultisig<'info> {
    /// `owner_key` while no multisig is bound, afterwards only `multisig_vault`.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [INSTITUTION_SEED, institution.owner_key.as_ref()],
        bump = institution.bump,
        constraint = institution.authority() == authority.key() @ PolicyError::Unauthorized,
    )]
    pub institution: Account<'info, Institution>,
    /// Squads v4 multisig account; must be owned by the Squads v4 program and initialized.
    /// CHECK: owner and discriminator are checked against Squads v4 (`square_common::squads`).
    #[account(address = multisig @ PolicyError::InvalidSquadsMultisig)]
    pub squads_multisig: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<SetInstitutionMultisig>,
    multisig: Pubkey,
    vault_index: u8,
) -> Result<()> {
    require!(
        squads::is_multisig(&ctx.accounts.squads_multisig),
        PolicyError::InvalidSquadsMultisig
    );
    let vault = squads::vault_address(&multisig, vault_index);
    let institution = &mut ctx.accounts.institution;
    institution.multisig = Some(multisig);
    institution.multisig_vault = Some(vault);
    emit!(InstitutionMultisigSet {
        institution: institution.key(),
        multisig,
        multisig_vault: vault
    });
    Ok(())
}
