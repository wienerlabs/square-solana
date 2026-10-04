//! CPI yerine hesap okuma (program arayüzü §4). Okuyan program, hesabın owner'ını ve PDA adresini
//! seed'lerden yeniden türeterek doğrular; ardından discriminator denetimiyle çözer. Owner, sözleşme
//! IDL'indeki adres değil, okuyanın config hesabında tuttuğu program kimliğidir.

use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;

/// `anchor_lang::Result` yerine okuma hatasını taşıyan sonuç.
pub type ReadResult<T> = core::result::Result<T, AccountReadError>;

/// Okuma reddinin sebebi. Programlar bunu kendi hata koduna çevirir (ör. `InvalidLinkedAccount`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountReadError {
    /// Hesabın sahibi beklenen program değil.
    WrongOwner,
    /// Adres, seed'lerden türetilen PDA değil.
    WrongAddress,
    /// Veri boş, discriminator farklı ya da düzen çözülemiyor.
    InvalidData,
}

/// `address`'in `program_id` altında `seeds`'ten türetilen kanonik PDA olduğunu doğrular; bump'ı döner.
pub fn verify_pda(address: &Pubkey, program_id: &Pubkey, seeds: &[&[u8]]) -> ReadResult<u8> {
    let (expected, bump) = Pubkey::find_program_address(seeds, program_id);
    if expected == *address {
        Ok(bump)
    } else {
        Err(AccountReadError::WrongAddress)
    }
}

/// Bump'ı bilinen PDA'yı (`seeds` + `[bump]`) doğrular; `find_program_address`'ten ucuzdur.
pub fn verify_pda_with_bump(
    address: &Pubkey,
    program_id: &Pubkey,
    seeds: &[&[u8]],
    bump: u8,
) -> ReadResult<()> {
    let bump = [bump];
    let mut with_bump = seeds.to_vec();
    with_bump.push(&bump);
    match Pubkey::create_program_address(&with_bump, program_id) {
        Ok(expected) if expected == *address => Ok(()),
        _ => Err(AccountReadError::WrongAddress),
    }
}

fn deserialize<T: AccountDeserialize>(info: &AccountInfo) -> ReadResult<T> {
    let data = info.try_borrow_data().map_err(|_| AccountReadError::InvalidData)?;
    T::try_deserialize(&mut &data[..]).map_err(|_| AccountReadError::InvalidData)
}

/// Owner'ı `owner`, adresi `seeds`'ten türetilen PDA olan hesabı `T` olarak okur.
pub fn read_pda<T: AccountDeserialize>(
    info: &AccountInfo,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> ReadResult<T> {
    if info.owner != owner {
        return Err(AccountReadError::WrongOwner);
    }
    verify_pda(info.key, owner, seeds)?;
    deserialize(info)
}

/// [`read_pda`] ile aynı; bump bilindiği için adres `create_program_address` ile doğrulanır.
pub fn read_pda_with_bump<T: AccountDeserialize>(
    info: &AccountInfo,
    owner: &Pubkey,
    seeds: &[&[u8]],
    bump: u8,
) -> ReadResult<T> {
    if info.owner != owner {
        return Err(AccountReadError::WrongOwner);
    }
    verify_pda_with_bump(info.key, owner, seeds, bump)?;
    deserialize(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::square_verifier_contract::accounts::{OperatorState, VerifierConfig};
    use crate::seeds::{OPERATOR_STATE_SEED, VERIFIER_CONFIG_SEED};
    use anchor_lang::AccountSerialize;

    /// Verifier program kimliği yerine test için türetilen sabit bir adres.
    fn program_id() -> Pubkey {
        Pubkey::new_from_array([7; 32])
    }

    fn institution() -> Pubkey {
        Pubkey::new_from_array([9; 32])
    }

    fn operator_state(bump: u8) -> Vec<u8> {
        let state = OperatorState {
            institution: institution(),
            daily_spent: 125_000_000,
            day_start_unix: 1_789_948_800,
            total_lifetime_payments: 3,
            bump,
        };
        let mut data = Vec::new();
        state.try_serialize(&mut data).unwrap();
        data
    }

    fn with_account<R>(key: Pubkey, owner: Pubkey, mut data: Vec<u8>, f: impl FnOnce(&AccountInfo) -> R) -> R {
        let mut lamports = 1_000_000u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        f(&info)
    }

    #[test]
    fn reads_account_with_matching_owner_and_seeds() {
        let inst = institution();
        let seeds: &[&[u8]] = &[OPERATOR_STATE_SEED, inst.as_ref()];
        let (address, bump) = Pubkey::find_program_address(seeds, &program_id());
        let read = with_account(address, program_id(), operator_state(bump), |info| {
            read_pda::<OperatorState>(info, &program_id(), seeds)
        })
        .unwrap();
        assert_eq!(read.institution, inst);
        assert_eq!(read.daily_spent, 125_000_000);
        assert_eq!(read.bump, bump);

        let again = with_account(address, program_id(), operator_state(bump), |info| {
            read_pda_with_bump::<OperatorState>(info, &program_id(), seeds, bump)
        })
        .unwrap();
        assert_eq!(again.day_start_unix, 1_789_948_800);
    }

    #[test]
    fn rejects_wrong_owner() {
        let inst = institution();
        let seeds: &[&[u8]] = &[OPERATOR_STATE_SEED, inst.as_ref()];
        let (address, bump) = Pubkey::find_program_address(seeds, &program_id());
        let other = Pubkey::new_from_array([8; 32]);
        let result = with_account(address, other, operator_state(bump), |info| {
            read_pda::<OperatorState>(info, &program_id(), seeds)
        });
        assert_eq!(result.unwrap_err(), AccountReadError::WrongOwner);
        let result = with_account(address, other, operator_state(bump), |info| {
            read_pda_with_bump::<OperatorState>(info, &program_id(), seeds, bump)
        });
        assert_eq!(result.unwrap_err(), AccountReadError::WrongOwner);
    }

    #[test]
    fn rejects_address_not_derived_from_seeds() {
        let inst = institution();
        let seeds: &[&[u8]] = &[OPERATOR_STATE_SEED, inst.as_ref()];
        let (_, bump) = Pubkey::find_program_address(seeds, &program_id());
        // Aynı program altında başka bir kurumun PDA'sı.
        let other_inst = Pubkey::new_from_array([10; 32]);
        let (decoy, decoy_bump) =
            Pubkey::find_program_address(&[OPERATOR_STATE_SEED, other_inst.as_ref()], &program_id());
        let result = with_account(decoy, program_id(), operator_state(bump), |info| {
            read_pda::<OperatorState>(info, &program_id(), seeds)
        });
        assert_eq!(result.unwrap_err(), AccountReadError::WrongAddress);
        let result = with_account(decoy, program_id(), operator_state(decoy_bump), |info| {
            read_pda_with_bump::<OperatorState>(info, &program_id(), seeds, decoy_bump)
        });
        assert_eq!(result.unwrap_err(), AccountReadError::WrongAddress);
        // Seed'ler doğru ama başka programın PDA'sı.
        let (foreign, _) = Pubkey::find_program_address(seeds, &Pubkey::new_from_array([8; 32]));
        assert_eq!(verify_pda(&foreign, &program_id(), seeds), Err(AccountReadError::WrongAddress));
    }

    #[test]
    fn rejects_other_account_type_and_short_data() {
        let seeds: &[&[u8]] = &[VERIFIER_CONFIG_SEED];
        let (address, bump) = Pubkey::find_program_address(seeds, &program_id());
        // Doğru adres ve owner, ama veri başka bir hesap tipinin (discriminator farklı).
        let result = with_account(address, program_id(), operator_state(bump), |info| {
            read_pda::<VerifierConfig>(info, &program_id(), seeds)
        });
        assert_eq!(result.unwrap_err(), AccountReadError::InvalidData);
        let result = with_account(address, program_id(), vec![1, 2, 3], |info| {
            read_pda::<VerifierConfig>(info, &program_id(), seeds)
        });
        assert_eq!(result.unwrap_err(), AccountReadError::InvalidData);
    }
}
