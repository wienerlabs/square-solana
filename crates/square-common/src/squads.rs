//! Squads v4 (dış program). Kurum bir multisig bağladığında yetkili, multisig'in vault PDA'sı olur
//! (program arayüzü §2). Program kimliği Squads v4'ün her kümede aynı olan dağıtım adresidir.

use anchor_lang::prelude::*;

/// Squads v4 programı.
pub const PROGRAM_ID: Pubkey = pubkey!("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

pub const MULTISIG_SEED: &[u8] = b"multisig";
pub const VAULT_SEED: &[u8] = b"vault";

/// Squads v4 `Multisig` hesabının Anchor discriminator'ı: `sha256("account:Multisig")[..8]`.
pub const MULTISIG_DISCRIMINATOR: [u8; 8] = [224, 116, 121, 186, 68, 161, 79, 236];

/// Multisig'in `vault_index`'inci vault PDA'sı: `["multisig", multisig, "vault", [vault_index]]`.
pub fn vault_address(multisig: &Pubkey, vault_index: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[MULTISIG_SEED, multisig.as_ref(), VAULT_SEED, &[vault_index]],
        &PROGRAM_ID,
    )
    .0
}

/// Hesap Squads v4'e ait, başlatılmış bir `Multisig` mi.
pub fn is_multisig(info: &AccountInfo) -> bool {
    info.owner == &PROGRAM_ID
        && info
            .try_borrow_data()
            .map(|data| {
                data.len() > MULTISIG_DISCRIMINATOR.len() && data[..8] == MULTISIG_DISCRIMINATOR
            })
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_account<R>(owner: Pubkey, mut data: Vec<u8>, f: impl FnOnce(&AccountInfo) -> R) -> R {
        let key = Pubkey::new_from_array([3; 32]);
        let mut lamports = 1_000_000u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        f(&info)
    }

    #[test]
    fn recognises_initialized_multisig_only() {
        let mut data = MULTISIG_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&[0; 32]);
        assert!(with_account(PROGRAM_ID, data.clone(), is_multisig));
        // Başka programın hesabı, boş hesap, başka hesap tipi.
        assert!(!with_account(
            Pubkey::new_from_array([1; 32]),
            data,
            is_multisig
        ));
        assert!(!with_account(PROGRAM_ID, vec![], is_multisig));
        assert!(!with_account(
            PROGRAM_ID,
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9],
            is_multisig
        ));
    }

    #[test]
    fn vault_is_the_squads_pda() {
        let multisig = Pubkey::new_from_array([4; 32]);
        let (expected, _) = Pubkey::find_program_address(
            &[b"multisig", multisig.as_ref(), b"vault", &[0]],
            &PROGRAM_ID,
        );
        assert_eq!(vault_address(&multisig, 0), expected);
        assert_ne!(vault_address(&multisig, 0), vault_address(&multisig, 1));
    }
}
