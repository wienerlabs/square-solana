//! Travel Rule commitment'ı (BC-34, ADR 0015). Eşiği aşan işte kurum, fonlamadan önce Travel Rule kaydının
//! salt'lı commitment'ını job'a bağlar (`commit_travel_rule`); kişisel veri zincire çıkmaz. Kayıt ve salt
//! zincir dışında, şifreli saklanır (BE-23); kaydı ve salt'ı gören taraf commitment'ı yeniden hesaplayıp
//! `Job.travel_rule_commitment` ile karşılaştırır.
//!
//! - kaydın özeti: `sha256(RFC 8785 kanonik JSON)`
//! - commitment: `sha256("square/travel-rule/v1" ‖ job ‖ salt ‖ kaydın özeti)`; job adresi commitment'ı
//!   tek bir işe bağlar, 32 baytlık rastgele salt kaydın tahminle sınanmasını engeller.

use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

/// Commitment'ın alan ayırıcısı (sürümlü).
pub const DOMAIN: &[u8] = b"square/travel-rule/v1";

/// Commitment'ı olmayan işin değeri.
pub const NONE: [u8; 32] = [0; 32];

/// `job`'a bağlanan commitment: `sha256(DOMAIN ‖ job ‖ salt ‖ record_digest)`.
pub fn commitment(job: &Pubkey, salt: &[u8; 32], record_digest: &[u8; 32]) -> [u8; 32] {
    hashv(&[DOMAIN, job.as_ref(), salt, record_digest]).to_bytes()
}

/// Commitment bağlanmış mı (32 sıfır bayt değil).
pub fn is_bound(commitment: &[u8; 32]) -> bool {
    *commitment != NONE
}

/// Eşik açıksa (`threshold > 0`) ve tutar eşiğe eşit ya da üstündeyse fonlamadan önce commitment gerekir.
pub fn required(amount: u64, threshold: u64) -> bool {
    threshold > 0 && amount >= threshold
}
