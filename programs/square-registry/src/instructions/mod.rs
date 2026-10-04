// Her talimat modülü kendi `handler`'ını tanımlar; lib.rs onları modül yoluyla çağırır, glob yeniden ihraç
// Anchor'ın ürettiği hesap modüllerinin kök yoldan erişilebilmesi içindir.
#![allow(ambiguous_glob_reexports)]

pub mod deregister_agent;
pub mod register_agent;
pub mod set_agent_status;
pub mod transfer_agent_ownership;
pub mod update_agent;

pub use deregister_agent::*;
pub use register_agent::*;
pub use set_agent_status::*;
pub use transfer_agent_ownership::*;
pub use update_agent::*;
