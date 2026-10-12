//! Square verifier programı (program arayüzü §10.3, BC-21). Akışın 7. adımı: kurum, release'ten önce
//! Groth16 ispatını job'a bağlar; program ispatı release devresinin 13 sinyaline karşı doğrular ve
//! escrow'un release'te okuyacağı `ReleaseProof`'u yazar (account-read, CPI yok). Sinyallerin 10'unu
//! program hesaplardan kurar (release-circuit.md §6, yol A). Tek CPI, escrow'un `record_release`'idir:
//! günlük sayaç (`OperatorState`) verifier'ındır ve yalnızca release'te ilerler (ADR 0012).
//!
//! Stripe MPP fiat rayı (BC-37, ADR 0024): `verify_mpp_payment_proof` fiat işin Stripe ödemesini MPP
//! authority'nin Ed25519 attestation'ı ve aynı devrenin ispatıyla (`stripe_receipt_hash` ≠ 0) job'a
//! bağlar; authority config'tedir ve `update_mpp_authority` ile program upgrade'i olmadan değişir.
//!
//! Kabul öncesi ön-ispat (ADR 0028): `set_preflight_proof` policy'li işin, agent kabul etmeden önce, kendi
//! koşullarıyla (net = tutar, payee = agent cüzdanı, sayaç 0) kalıcı ya da günlük tavan biti olmadan geçtiğini
//! `PreflightProof`'a yazar; escrow `accept_job`'da onu ister.
use anchor_lang::prelude::*;

pub mod binding;
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
#[constant]
pub const PREFLIGHT_PROOF_SEED: &[u8] = square_common::seeds::PREFLIGHT_PROOF_SEED;

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

    /// Pre-acceptance compliance proof (ADR 0028): before the agent accepts a policy job (Open or
    /// Funded), the institution's authority proves the job against its own terms. The program builds
    /// the signals from the job: net = `job.amount` (the upper bound of every release to the agent
    /// side), payee = `Job.agent_wallet`, mint, daily counter 0, the job address and a zero
    /// `stripe_receipt_hash`; the policy snapshot is the job's. `refusal_code` must have no permanent
    /// bit and no daily-ceiling bit (time window and category are temporary); otherwise
    /// `PreflightRefused`. Writes `PreflightProof` with the payee, which escrow `accept_job` requires while
    /// the job's agent wallet is unchanged; can be re-bound until acceptance. Arguments: `refusal_code` is public signal 0; `proof_timestamp` is public
    /// signal 9 (Unix seconds), within the clock tolerance.
    pub fn set_preflight_proof(
        ctx: Context<SetPreflightProof>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        refusal_code: u16,
        proof_timestamp: i64,
    ) -> Result<()> {
        instructions::set_preflight_proof::handler(
            ctx,
            proof_a,
            proof_b,
            proof_c,
            refusal_code,
            proof_timestamp,
        )
    }

    /// The config admin (Squads vault) rotates the MPP attestation key without a program upgrade. A
    /// zero key disables the fiat rail: no attestation can verify.
    pub fn update_mpp_authority(
        ctx: Context<UpdateMppAuthority>,
        mpp_authority: Pubkey,
    ) -> Result<()> {
        instructions::update_mpp_authority::handler(ctx, mpp_authority)
    }

    /// Fiat rail (ADR 0024): binds a Stripe (MPP) payment to a delivered fiat job. The instruction
    /// right before it must be the Ed25519 precompile verifying `config.mpp_authority`'s signature on
    /// `"square/mpp-attestation/v1" || job || stripe_receipt_hash || amount (u64 LE)`, `amount` being
    /// the job amount. The Groth16 proof is checked against the same 13 signals as
    /// `set_compliance_proof` with `refusal_code` 0, `net_amount` = job amount, payee = agent wallet
    /// and the non-zero `stripe_receipt_hash` (public signal 12). Writes a `Compliant` `ReleaseProof`
    /// that `finalize_fiat_payment` consumes. Arguments: `stripe_receipt_hash` is the Poseidon
    /// commitment of the Stripe receipt; `proof_timestamp` is public signal 9 (Unix seconds).
    pub fn verify_mpp_payment_proof(
        ctx: Context<VerifyMppPaymentProof>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        stripe_receipt_hash: [u8; 32],
        proof_timestamp: i64,
    ) -> Result<()> {
        instructions::verify_mpp_payment_proof::handler(
            ctx,
            proof_a,
            proof_b,
            proof_c,
            stripe_receipt_hash,
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
