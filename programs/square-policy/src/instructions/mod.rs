// Her talimat modülü kendi `handler`'ını tanımlar; lib.rs onları modül yoluyla çağırır, glob yeniden ihraç
// Anchor'ın ürettiği hesap modüllerinin kök yoldan erişilebilmesi içindir.
#![allow(ambiguous_glob_reexports)]

pub mod deactivate_policy;
pub mod init_institution;
pub mod set_institution_multisig;
pub mod set_policy;
pub mod update_policy;

pub use deactivate_policy::*;
pub use init_institution::*;
pub use set_institution_multisig::*;
pub use set_policy::*;
pub use update_policy::*;
