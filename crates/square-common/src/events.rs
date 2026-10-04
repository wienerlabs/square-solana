//! Event'ler (BC-16, [`docs/design/events.md`]). Sözleşme IDL'leri event'lerin tek kaynağıdır.
//!
//! - [`registry`], [`policy`], [`verifier`], [`escrow`]: sözleşmeden üretilen kanonik event tipleri;
//!   Rust tarafında çözme ve karşılaştırma için.
//! - `square_<program>_events!()`: programın crate kökünde çağrılır ve aynı event'leri o crate'te
//!   `#[event]` olarak tanımlar; böylece event'ler programın IDL'ine girer ve `emit!` ile yayımlanır.
//!   Alanlardaki tanımlı tipler (`AgentStatus`, `DisputeResolution` …) programın kendi tipleridir.
//!
//! [`docs/design/events.md`]: https://github.com/wienerlabs/square-solana/blob/main/docs/design/events.md

pub use crate::contract::square_escrow_contract::events as escrow;
pub use crate::contract::square_policy_contract::events as policy;
pub use crate::contract::square_registry_contract::events as registry;
pub use crate::contract::square_verifier_contract::events as verifier;

include!(concat!(env!("OUT_DIR"), "/events_macros.rs"));

/// Makronun ürettiği her event, sözleşme tipiyle aynı değerde aynı baytları (discriminator dahil)
/// vermelidir.
#[cfg(test)]
mod layout {
    include!(concat!(env!("OUT_DIR"), "/events_tests.rs"));
}
