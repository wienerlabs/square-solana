use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU");

#[program]
pub mod policy_registry {
    use super::*;

    pub fn initialize_operator(
        ctx: Context<InitializeOperator>,
        operator_name: String,
    ) -> Result<()> {
        instructions::initialize_operator::handler(ctx, operator_name)
    }

    pub fn register_policy(
        ctx: Context<RegisterPolicy>,
        policy_id: [u8; 32],
        merkle_root: [u8; 32],
        policy_data_hash: [u8; 32],
    ) -> Result<()> {
        instructions::register_policy::handler(ctx, policy_id, merkle_root, policy_data_hash)
    }

    pub fn update_policy(
        ctx: Context<UpdatePolicy>,
        new_merkle_root: [u8; 32],
        new_policy_data_hash: [u8; 32],
    ) -> Result<()> {
        instructions::update_policy::handler(ctx, new_merkle_root, new_policy_data_hash)
    }

    pub fn deactivate_policy(ctx: Context<DeactivatePolicy>) -> Result<()> {
        instructions::deactivate_policy::handler(ctx)
    }

    pub fn set_multisig(
        ctx: Context<SetMultisig>,
        vault_index: u8,
    ) -> Result<()> {
        instructions::set_multisig::handler(ctx, vault_index)
    }

    pub fn register_policy_multisig(
        ctx: Context<RegisterPolicyMultisig>,
        policy_id: [u8; 32],
        merkle_root: [u8; 32],
        policy_data_hash: [u8; 32],
        vault_index: u8,
    ) -> Result<()> {
        instructions::register_policy_multisig::handler(ctx, policy_id, merkle_root, policy_data_hash, vault_index)
    }

    pub fn update_policy_multisig(
        ctx: Context<UpdatePolicyMultisig>,
        new_merkle_root: [u8; 32],
        new_policy_data_hash: [u8; 32],
        vault_index: u8,
    ) -> Result<()> {
        instructions::update_policy_multisig::handler(ctx, new_merkle_root, new_policy_data_hash, vault_index)
    }
}
