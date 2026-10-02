/// BC-11: the transfer-hook path (`record_payment`) was removed. `verify_payment_proof_v2` and
/// `verify_payment_proof_v2_with_transfer` relied on it for recipient/mint/amount binding, the
/// daily-spent update and proof consumption, so they fail closed until BC-21 replaces them with
/// `set_compliance_proof` / `record_release`. Their bodies stay as the BC-21 starting point.
pub(crate) const TRANSFER_HOOK_PATHS_ENABLED: bool = false;

pub mod verify_payment_v2;
pub mod verify_payment_v2_with_transfer;
pub mod initialize_operator_state;
pub mod verify_mpp_payment_proof;

pub use verify_payment_v2::*;
pub use verify_payment_v2_with_transfer::*;
pub use initialize_operator_state::*;
pub use verify_mpp_payment_proof::*;
