//! Squads v4 fikstürü: multisig hesabı ve vault imzacısı.
//!
//! Squads programının kendisi ortamda yoktur. Square programları Squads'tan yalnızca iki şey bekler
//! (`square_common::squads`): multisig hesabının Squads v4'e ait ve başlatılmış bir `Multisig` olması
//! (sahip + Anchor discriminator'ı) ve işlemi multisig'in vault PDA'sının imzalaması. Fikstür hesabı bu
//! kadarıyla yazar (discriminator + boş gövde); vault, square-common'daki türetmeyle bulunur ve imza
//! doğrulamasız ortamda imzacı olur ([`crate::Harness::send_as`]). Squads'ın kendi kuralları (üyeler,
//! eşik, onaylar) burada denenmez; onlar Squads'ın sorumluluğudur.

use anchor_lang::prelude::Pubkey;
use solana_account::Account;
use square_common::squads::{vault_address, MULTISIG_DISCRIMINATOR, PROGRAM_ID};

use crate::Harness;

pub struct SquadsMultisig {
    pub address: Pubkey,
}

impl SquadsMultisig {
    /// Squads v4'e ait, `Multisig` discriminator'ıyla başlatılmış bir hesap.
    pub fn create(h: &mut Harness) -> Self {
        let address = Pubkey::new_unique();
        let mut data = MULTISIG_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&[0; 32]);
        write(h, address, data, PROGRAM_ID);
        Self { address }
    }

    /// Multisig'in `index` numaralı vault PDA'sı.
    pub fn vault(&self, index: u8) -> Pubkey {
        vault_address(&self.address, index)
    }
}

/// Squads'a ait olmayan ya da `Multisig` olmayan bir hesap; reddedilmesi gereken durumlar için.
pub fn write_account(h: &mut Harness, data: Vec<u8>, owner: Pubkey) -> Pubkey {
    let address = Pubkey::new_unique();
    write(h, address, data, owner);
    address
}

fn write(h: &mut Harness, address: Pubkey, data: Vec<u8>, owner: Pubkey) {
    let lamports = h.svm.minimum_balance_for_rent_exemption(data.len());
    h.set_account(
        address,
        Account {
            lamports,
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    );
}
