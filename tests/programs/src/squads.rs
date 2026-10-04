//! Squads v4 fikstürü: multisig hesabı ve vault imzacısı.
//!
//! Squads programının kendisi ortamda yoktur. Square programları Squads'tan yalnızca iki şey bekler:
//! multisig hesabının Squads programına ait ve dolu olması, işlemi multisig'in vault PDA'sının imzalaması.
//! Hesap, Squads programına ait ve Square programlarının okuduğu kadar dolu yazılır; vault, Squads'ın
//! seed'leriyle (`["multisig", multisig, "vault", index]`, square-common) türetilir ve imza doğrulamasız
//! ortamda imzacı olur ([`crate::Harness::send_as`]). Squads'ın kendi kuralları (eşik, onaylar) burada
//! denenmez; onlar Squads'ın sorumluluğudur.

use anchor_lang::prelude::Pubkey;
use solana_account::Account;
use square_common::seeds::squads::{MULTISIG_SEED, VAULT_SEED};

use crate::Harness;

pub struct SquadsMultisig {
    pub address: Pubkey,
    pub program: Pubkey,
}

impl SquadsMultisig {
    /// `program` (Squads v4) sahipliğinde, verisi boş olmayan bir multisig hesabı.
    pub fn create(h: &mut Harness, program: Pubkey) -> Self {
        let address = Pubkey::new_unique();
        let data = address.to_bytes().to_vec();
        let lamports = h.svm.minimum_balance_for_rent_exemption(data.len());
        h.set_account(
            address,
            Account {
                lamports,
                data,
                owner: program,
                executable: false,
                rent_epoch: 0,
            },
        );
        Self { address, program }
    }

    /// Multisig'in `index` numaralı vault PDA'sı.
    pub fn vault(&self, index: u8) -> Pubkey {
        Pubkey::find_program_address(
            &[MULTISIG_SEED, self.address.as_ref(), VAULT_SEED, &[index]],
            &self.program,
        )
        .0
    }
}
