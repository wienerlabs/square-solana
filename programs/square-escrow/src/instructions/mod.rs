// Her talimat modülü kendi `handler`'ını tanımlar; lib.rs onları modül yoluyla çağırır, glob yeniden ihraç
// Anchor'ın ürettiği hesap modüllerinin kök yoldan erişilebilmesi içindir.
#![allow(ambiguous_glob_reexports)]

pub mod accept_job;
pub mod agent_job;
pub mod cancel_job;
pub mod create_job;
pub mod fund_job;
pub mod init_config;
pub mod submit_work;
pub mod sync_agent_wallet;
pub mod update_params;

pub use agent_job::*;
pub use cancel_job::*;
pub use create_job::*;
pub use fund_job::*;
pub use init_config::*;
pub use sync_agent_wallet::*;
pub use update_params::*;
