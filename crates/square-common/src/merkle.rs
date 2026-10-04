//! Onaylı alıcı listesi Merkle ağacı (program arayüzü, "Alıcı listesi Merkle ağacı"). Kökü kurum
//! `set_buyer_root` ile yayımlar; escrow `buy_claim`'de alıcının kanıtını bununla doğrular. Ağacı ve
//! kanıtları `@squaresdk/solana-policy` üretir; iki uygulamanın uyumu ortak test vektörleriyle denetlenir.
//!
//! - yaprak: `sha256(buyer ‖ leaf_salt)`
//! - iç düğüm: `sha256(min(a, b) ‖ max(a, b))` (32 baytın sözlük sırası)
//! - tek kalan düğüm üst seviyeye değişmeden taşınır; kök kalan tek düğümdür
//! - kök 32 sıfır bayt: alım kısıtsız
//! - kanıt: yapraktan köke kardeşler, en fazla [`MAX_BUYER_PROOF_DEPTH`]

use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

pub use crate::constants::MAX_BUYER_PROOF_DEPTH;

/// Kısıtsız alıcı listesinin kökü.
pub const UNRESTRICTED_ROOT: [u8; 32] = [0; 32];

/// Alıcının yaprağı: `sha256(buyer ‖ leaf_salt)`.
pub fn buyer_leaf(buyer: &Pubkey, leaf_salt: &[u8; 32]) -> [u8; 32] {
    hashv(&[buyer.as_ref(), leaf_salt]).to_bytes()
}

/// İki düğümün ebeveyni: sıralı çiftin hash'i.
pub fn parent(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (low, high) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[low, high]).to_bytes()
}

/// Kök kısıtsız mı (32 sıfır bayt).
pub fn is_unrestricted(root: &[u8; 32]) -> bool {
    *root == UNRESTRICTED_ROOT
}

/// `buyer`'ın `leaf_salt` ve `proof` ile `root`'lu listede olduğunu doğrular. Kısıtsız kök her alıcıyı
/// kabul eder; [`MAX_BUYER_PROOF_DEPTH`]'ten uzun kanıt reddedilir.
pub fn verify_buyer_proof(
    root: &[u8; 32],
    buyer: &Pubkey,
    leaf_salt: &[u8; 32],
    proof: &[[u8; 32]],
) -> bool {
    if is_unrestricted(root) {
        return true;
    }
    if proof.len() > MAX_BUYER_PROOF_DEPTH {
        return false;
    }
    proof
        .iter()
        .fold(buyer_leaf(buyer, leaf_salt), |node, sibling| {
            parent(&node, sibling)
        })
        == *root
}
