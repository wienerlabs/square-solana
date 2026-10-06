//! Square policy programı (program arayüzü §10.2, BC-17). Akışın 1. adımı: kurum harcama yetkisini
//! salt'lı Poseidon commitment'ı olarak yazar; politikanın kendisi zincire çıkmaz, yalnızca günlük
//! tavan public'tir.
use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4");

square_common::square_policy_events!();

// PDA seed'leri IDL'de de yayımlanır; değerler sözleşmeden (square-common).
#[constant]
pub const INSTITUTION_SEED: &[u8] = square_common::seeds::INSTITUTION_SEED;
#[constant]
pub const POLICY_SEED: &[u8] = square_common::seeds::POLICY_SEED;

#[program]
pub mod square_policy {
    use super::*;

    /// Deactivates a policy: no new jobs can reference it. Existing jobs settle against their snapshot.
    pub fn deactivate_policy(ctx: Context<DeactivatePolicy>) -> Result<()> {
        instructions::deactivate_policy::handler(ctx)
    }

    /// Creates the institution account for `authority` (which becomes `owner_key`).
    pub fn init_institution(ctx: Context<InitInstitution>, name: String) -> Result<()> {
        instructions::init_institution::handler(ctx, name)
    }

    /// Flow step 5 (institution side): publishes the root of the salted approved-buyer list.
    /// Leaf = sha256(buyer_pubkey || leaf_salt); escrow `buy_claim` checks a Merkle proof against the
    /// current root. An all-zero root means "no buyer restriction".
    pub fn set_buyer_root(ctx: Context<SetBuyerRoot>, buyer_root: [u8; 32]) -> Result<()> {
        instructions::set_buyer_root::handler(ctx, buyer_root)
    }

    /// Binds (or, signed by the current vault, rebinds) a Squads v4 multisig. Afterwards only its
    /// vault PDA (`vault_index`) may sign as authority.
    pub fn set_institution_multisig(
        ctx: Context<SetInstitutionMultisig>,
        multisig: Pubkey,
        vault_index: u8,
    ) -> Result<()> {
        instructions::set_institution_multisig::handler(ctx, multisig, vault_index)
    }

    /// Flow step 1: commits a spending policy. Only the salted Poseidon commitment and the public
    /// daily ceiling (settlement-mint atomic units) are stored.
    pub fn set_policy(
        ctx: Context<SetPolicy>,
        policy_id: [u8; 32],
        commitment: [u8; 32],
        daily_ceiling: u64,
    ) -> Result<()> {
        instructions::set_policy::handler(ctx, policy_id, commitment, daily_ceiling)
    }

    /// Replaces the commitment and/or daily ceiling and increments `version`. Existing jobs keep the
    /// snapshot taken at `create_job`.
    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        commitment: [u8; 32],
        daily_ceiling: u64,
    ) -> Result<()> {
        instructions::update_policy::handler(ctx, commitment, daily_ceiling)
    }
}
