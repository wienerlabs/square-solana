//! Sözleşme IDL'lerinden üretilen tipler (`idls/` → repo kökündeki `idl/`). Programlar birbirinin
//! crate'ine bağımlı olmadan, okudukları hesapların sözleşmedeki düzenini buradan alır. Owner
//! denetimi IDL'deki adrese değil, çağıranın verdiği program kimliğine göre yapılır
//! ([`crate::account_read`]): program kimlikleri config hesaplarından gelir (program arayüzü §4).
#![allow(missing_docs)]

use anchor_lang::prelude::*;

declare_program!(square_registry_contract);
declare_program!(square_policy_contract);
declare_program!(square_verifier_contract);
declare_program!(square_escrow_contract);
