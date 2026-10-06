//! Square verifier programı (program arayüzü §10.3, BC-21). Akışın 7. adımı: kurum, release'ten önce
//! Groth16 ispatını job'a bağlar; program ispatı release devresinin 13 sinyaline karşı doğrular ve
//! escrow'un release'te okuyacağı `ReleaseProof`'u yazar (account-read, CPI yok). Sinyallerin 10'unu
//! program hesaplardan kurar (release-circuit.md §6, yol A). Tek CPI, escrow'un `record_release`'idir:
//! günlük sayaç (`OperatorState`) verifier'ındır ve yalnızca release'te ilerler (ADR 0012).
//!
//! Stripe MPP yolu (`verify_mpp_payment_proof`, `update_mpp_authority`) BC-37'de.
use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod linked;
/// Square release devresinin doğrulama anahtarı (BC-20, üretilir).
#[rustfmt::skip]
pub mod release_vk;
pub mod signals;
pub mod state;

#[cfg(test)]
mod release_vk_tests;
#[cfg(test)]
#[rustfmt::skip]
mod release_vk_vector;

use instructions::*;
pub use state::ReleaseVerdict;

// Kaynak programın (Aperture verifier) adresi; Square'in program kimlikleri BC-09'da.
declare_id!("8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh");

square_common::square_verifier_events!();

// PDA seed'leri IDL'de de yayımlanır; değerler sözleşmeden (square-common).
#[constant]
pub const VERIFIER_CONFIG_SEED: &[u8] = square_common::seeds::VERIFIER_CONFIG_SEED;
#[constant]
pub const OPERATOR_STATE_SEED: &[u8] = square_common::seeds::OPERATOR_STATE_SEED;
#[constant]
pub const RELEASE_PROOF_SEED: &[u8] = square_common::seeds::RELEASE_PROOF_SEED;

/// İspatın anı (`proof_timestamp`, sinyal 9) ile zincirin saati arasındaki en büyük fark (ADR 0012).
pub const CLOCK_TOLERANCE_SECS: i64 = 600;
/// Gömülü doğrulama anahtarının sürümü: BC-20'nin geliştirme anahtarı. Kamusal tören (BC-38) artırır; upgrade'den
/// sonra `sync_vk_version` config'e yazar.
pub const RELEASE_VK_VERSION: u16 = 1;

#[program]
pub mod square_verifier {
    use super::*;

    /// Creates the singleton verifier config. Only the program upgrade authority (Squads vault) can
    /// call it. `escrow_program` / `policy_program` pin the owners checked on account-read.
    pub fn init_verifier_config(
        ctx: Context<InitVerifierConfig>,
        escrow_program: Pubkey,
        policy_program: Pubkey,
        mpp_authority: Pubkey,
    ) -> Result<()> {
        instructions::init_verifier_config::handler(
            ctx,
            escrow_program,
            policy_program,
            mpp_authority,
        )
    }

    /// CPI-only (escrow, signed by its `escrow_authority` PDA): marks the release proof consumed and
    /// advances `OperatorState.daily_spent` (UTC-day rollover) by the released net amount.
    pub fn record_release(ctx: Context<RecordRelease>) -> Result<()> {
        instructions::record_release::handler(ctx)
    }

    /// Flow step 7: verifies a Groth16 proof (alt_bn128) of the release circuit (13 public signals,
    /// docs/design/release-circuit.md §2). The program builds ten of the signals itself from the
    /// accounts: the job's policy snapshot (`Job.policy_commitment`, `Job.policy_daily_ceiling`), the
    /// payee (claim buyer if the receivable was sold, else `Job.agent_wallet`), the mint, the
    /// institution's daily counter (`OperatorState`, UTC day rollover applied), the job address and a
    /// zero `stripe_receipt_hash`. The caller supplies `refusal_code`, `net_amount` and
    /// `proof_timestamp`, which must be within the clock tolerance. Writes `ReleaseProof` with a verdict;
    /// a refusing proof records `Refused` + reason code. Can be re-bound until escrow consumes it.
    /// Arguments: `refusal_code` is public signal 0, the bit mask of broken rules (0 when compliant,
    /// release-circuit.md §3); `net_amount` is public signal 5, the amount the payee receives;
    /// `proof_timestamp` is public signal 9, the instant the proof evaluates the policy at (Unix seconds).
    #[allow(clippy::too_many_arguments)]
    pub fn set_compliance_proof(
        ctx: Context<SetComplianceProof>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        refusal_code: u16,
        net_amount: u64,
        proof_timestamp: i64,
    ) -> Result<()> {
        instructions::set_compliance_proof::handler(
            ctx,
            proof_a,
            proof_b,
            proof_c,
            refusal_code,
            net_amount,
            proof_timestamp,
        )
    }

    /// After an upgrade that embeds a new verifying key (phase-2 ceremony, BC-38), records the program's
    /// `RELEASE_VK_VERSION` in the config. Only the config admin (Squads vault) can call it, in a vault
    /// transaction after the upgrade; it fails when the config already records this version.
    pub fn sync_vk_version(ctx: Context<SyncVkVersion>) -> Result<()> {
        instructions::sync_vk_version::handler(ctx)
    }
}
