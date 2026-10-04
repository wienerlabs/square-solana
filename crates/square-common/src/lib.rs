// SPDX-License-Identifier: Apache-2.0
//! square-common — Square programlarının paylaştığı tanımlar (BC-10, program arayüzü §4–§5).
//!
//! - [`contract`]: sözleşme IDL'lerinden (`idl/*.json`, `idls/` bağı) `declare_program!` ile üretilen
//!   hesap tipleri ve sabitler. Programlar arası okunan hesapların düzeni ve seed'ler buradan gelir.
//! - [`seeds`]: PDA seed'leri; sözleşme seed'leri IDL sabitlerinin kendisidir.
//! - [`roles`]: rol sözlüğü.
//! - [`constants`], [`time`]: ortak sabitler ve UTC gün başlangıcı.
//! - [`account_read`]: CPI yerine hesap okuma; owner ve PDA adresi doğrulanır.

pub mod account_read;
pub mod constants;
pub mod contract;
pub mod roles;
pub mod seeds;
pub mod time;
