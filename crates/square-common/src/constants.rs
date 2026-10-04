//! Programlar arasında ortak sabitler.

/// Baz puan paydası (`keeper_fee_bps`, bond oranları).
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Bir UTC gününün saniyesi.
pub const SECONDS_PER_DAY: i64 = 86_400;

/// Alıcı Merkle kanıtının en fazla derinliği (program arayüzü, "Alıcı listesi Merkle ağacı").
pub const MAX_BUYER_PROOF_DEPTH: usize = 16;
