//! Sanctions screening kaydının denetimi (program arayüzü §4, BC-27). Escrow `fund_job`'da (kurum ve
//! agent), `buy_claim`'de (alıcı) ve release'te (payee) aynı kuralı uygular: hesap registry'nin
//! `["screening", wallet]` PDA'sıdır, durumu `Clear`'dır ve süresi dolmamıştır (`expires_at > now`).
//! Kaydı registry'nin `record_screening`'i yazar; yalnızca config'teki screener yetkilisi imzalayabilir.

use anchor_lang::prelude::*;

use crate::account_read::read_pda;
use crate::contract::square_registry_contract::accounts::ScreeningRecord;
use crate::contract::square_registry_contract::types::ScreeningStatus;
use crate::seeds::SCREENING_SEED;

/// Screening reddinin sebebi. Escrow'un `ScreeningRequired`, `ScreeningFlagged` ve `ScreeningExpired`
/// kodlarına karşılık gelir.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreeningRejection {
    /// Hesap yok, registry'ye ait değil, `wallet`'ın screening PDA'sı değil ya da çözülemiyor.
    Missing,
    /// Cüzdan işaretli (`Flagged`); kaydın süresinden bağımsızdır.
    Flagged,
    /// Kaydın süresi dolmuş: `expires_at <= now`.
    Expired,
}

/// Kaydın `now` anında temiz ve taze olup olmadığı.
pub fn check(record: &ScreeningRecord, now: i64) -> core::result::Result<(), ScreeningRejection> {
    if !matches!(record.status, ScreeningStatus::Clear) {
        return Err(ScreeningRejection::Flagged);
    }
    if record.expires_at <= now {
        return Err(ScreeningRejection::Expired);
    }
    Ok(())
}

/// `info`'yu `wallet`'ın screening kaydı olarak okur (owner `registry_program`, adres
/// `["screening", wallet]`) ve [`check`]'ten geçirir; kaydı döner.
pub fn require_clear(
    info: &AccountInfo,
    registry_program: &Pubkey,
    wallet: &Pubkey,
    now: i64,
) -> core::result::Result<ScreeningRecord, ScreeningRejection> {
    let record: ScreeningRecord =
        read_pda(info, registry_program, &[SCREENING_SEED, wallet.as_ref()])
            .map_err(|_| ScreeningRejection::Missing)?;
    check(&record, now)?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AccountSerialize;

    const NOW: i64 = 1_790_000_000;

    /// Registry program kimliği yerine test için sabit bir adres.
    fn registry() -> Pubkey {
        Pubkey::new_from_array([3; 32])
    }

    fn wallet() -> Pubkey {
        Pubkey::new_from_array([5; 32])
    }

    fn record(status: ScreeningStatus, expires_at: i64, bump: u8) -> Vec<u8> {
        let record = ScreeningRecord {
            wallet: wallet(),
            status,
            source_hash: [8; 32],
            screened_at: NOW - 60,
            expires_at,
            bump,
        };
        let mut data = Vec::new();
        record.try_serialize(&mut data).unwrap();
        data
    }

    fn read(
        key: Pubkey,
        owner: Pubkey,
        mut data: Vec<u8>,
        wallet: Pubkey,
    ) -> core::result::Result<ScreeningRecord, ScreeningRejection> {
        let mut lamports = 1_000_000u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        require_clear(&info, &registry(), &wallet, NOW)
    }

    fn address() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[SCREENING_SEED, wallet().as_ref()], &registry())
    }

    #[test]
    fn a_clear_and_fresh_record_passes() {
        let (key, bump) = address();
        let read = read(
            key,
            registry(),
            record(ScreeningStatus::Clear, NOW + 1, bump),
            wallet(),
        )
        .unwrap();
        assert_eq!(read.wallet, wallet());
        assert_eq!(read.expires_at, NOW + 1);
        assert_eq!(read.source_hash, [8; 32]);
    }

    #[test]
    fn a_record_expiring_now_is_stale() {
        let (key, bump) = address();
        let data = record(ScreeningStatus::Clear, NOW, bump);
        assert_eq!(
            read(key, registry(), data, wallet()).unwrap_err(),
            ScreeningRejection::Expired
        );
    }

    #[test]
    fn a_flagged_record_is_rejected_even_when_fresh() {
        let (key, bump) = address();
        for expires_at in [NOW + 3_600, NOW - 1] {
            let data = record(ScreeningStatus::Flagged, expires_at, bump);
            assert_eq!(
                read(key, registry(), data, wallet()).unwrap_err(),
                ScreeningRejection::Flagged
            );
        }
    }

    #[test]
    fn a_foreign_misplaced_or_empty_account_is_missing() {
        let (key, bump) = address();
        let clear = || record(ScreeningStatus::Clear, NOW + 3_600, bump);
        // Registry'ye ait değil.
        assert_eq!(
            read(key, Pubkey::new_unique(), clear(), wallet()).unwrap_err(),
            ScreeningRejection::Missing
        );
        // Başka bir cüzdanın kaydı.
        assert_eq!(
            read(key, registry(), clear(), Pubkey::new_unique()).unwrap_err(),
            ScreeningRejection::Missing
        );
        // Hesap açılmamış.
        assert_eq!(
            read(key, registry(), Vec::new(), wallet()).unwrap_err(),
            ScreeningRejection::Missing
        );
    }
}
