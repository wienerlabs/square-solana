use anchor_lang::prelude::*;
use square_common::seeds::INSTITUTION_SEED;

use crate::errors::PolicyError;
use crate::state::Institution;
use crate::InstitutionCreated;

#[derive(Accounts)]
pub struct InitInstitution<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Institution::SPACE,
        seeds = [INSTITUTION_SEED, authority.key().as_ref()],
        bump,
    )]
    pub institution: Account<'info, Institution>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitInstitution>, name: String) -> Result<()> {
    require!(
        name.len() <= Institution::MAX_NAME_LEN,
        PolicyError::NameTooLong
    );
    let institution = &mut ctx.accounts.institution;
    institution.owner_key = ctx.accounts.authority.key();
    institution.policy_count = 0;
    institution.created_at = Clock::get()?.unix_timestamp;
    institution.bump = ctx.bumps.institution;
    institution.name = name.clone();
    institution.multisig = None;
    institution.multisig_vault = None;
    emit!(InstitutionCreated {
        institution: institution.key(),
        owner_key: institution.owner_key,
        name
    });
    Ok(())
}
