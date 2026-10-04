use anchor_lang::prelude::*;

/// seeds = ["institution", owner_key]
#[account]
pub struct Institution {
    /// The key the institution was created with; part of the PDA seeds, never changes.
    pub owner_key: Pubkey,
    pub policy_count: u32,
    pub created_at: i64,
    pub bump: u8,
    pub name: String,
    /// Squads v4 multisig bound with `set_institution_multisig`.
    pub multisig: Option<Pubkey>,
    /// Squads vault PDA that is the sole authority once set (derived from `multisig` + vault index).
    pub multisig_vault: Option<Pubkey>,
}

impl Institution {
    pub const MAX_NAME_LEN: usize = 64;
    pub const SPACE: usize = 8 + 32 + 4 + 8 + 1 + (4 + Self::MAX_NAME_LEN) + (1 + 32) + (1 + 32);

    /// Kurumun güncel yetkilisi: multisig bağlanana kadar `owner_key`, sonrasında yalnızca vault PDA'sı.
    pub fn authority(&self) -> Pubkey {
        self.multisig_vault.unwrap_or(self.owner_key)
    }
}

/// seeds = ["policy", institution, policy_id]
#[account]
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

impl Policy {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 32 + 4 + 1 + 8 + 8 + 1;
}
