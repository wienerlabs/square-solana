//! square_registry sanctions screening'i (sözleşme arayüzü, BC-27): registry config'ini yalnızca yükseltme
//! yetkilisi kurar, screening kaydını yalnızca config'teki screener yazar; escrow'un okuduğu kural
//! (`square_common::screening`) programın yazdığı hesapla denenir.

use anchor_lang::prelude::{AccountInfo, Pubkey};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::screening::{require_clear, ScreeningRejection};
use square_common::seeds::{REGISTRY_CONFIG_SEED, SCREENING_SEED};
use square_program_tests::{
    anchor_error, cu, event, programdata_address, Executed, Failed, Harness,
};
use square_registry::errors::RegistryError;
use square_registry::state::{RegistryConfig, ScreeningRecord};
use square_registry::{RegistryConfigUpdated, ScreeningRecorded, ScreeningStatus};

const NOW: i64 = 1_790_000_000;
const TTL: i64 = 30 * 24 * 60 * 60;
const SOURCE_HASH: [u8; 32] = [0x5c; 32];
const LAMPORTS: u64 = 1_000_000_000;

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[REGISTRY_CONFIG_SEED], &square_registry::ID).0
}

fn screening_address(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[SCREENING_SEED, wallet.as_ref()], &square_registry::ID).0
}

fn init_config_ix(admin: &Pubkey, screener: Pubkey, ttl: i64) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::InitRegistryConfig {
            admin: *admin,
            config: config_address(),
            program: square_registry::ID,
            program_data: programdata_address(&square_registry::ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_registry::instruction::InitRegistryConfig {
            screener_authority: screener,
            screening_ttl_secs: ttl,
        }
        .data(),
    }
}

fn update_config_ix(admin: &Pubkey, screener: Pubkey, ttl: i64) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::UpdateRegistryConfig {
            admin: *admin,
            config: config_address(),
        }
        .to_account_metas(None),
        data: square_registry::instruction::UpdateRegistryConfig {
            screener_authority: screener,
            screening_ttl_secs: ttl,
        }
        .data(),
    }
}

fn record_ix(
    payer: &Pubkey,
    screener: &Pubkey,
    wallet: Pubkey,
    status: ScreeningStatus,
    source_hash: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::RecordScreening {
            payer: *payer,
            screener_authority: *screener,
            config: config_address(),
            screening_record: screening_address(&wallet),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_registry::instruction::RecordScreening {
            wallet,
            status,
            source_hash,
        }
        .data(),
    }
}

/// Yükseltme yetkilisi `admin` olan registry; config henüz kurulmamış.
fn deployed() -> (Harness, Keypair) {
    let mut h = Harness::new();
    let admin = Keypair::new();
    h.deploy_upgradeable("square_registry", square_registry::ID, admin.pubkey());
    h.svm.airdrop(&admin.pubkey(), LAMPORTS).expect("airdrop");
    h.set_time(NOW);
    (h, admin)
}

/// Config'i kurulmuş registry: (harness, admin, screener).
fn configured() -> (Harness, Keypair, Keypair) {
    let (mut h, admin) = deployed();
    let screener = Keypair::new();
    h.send(
        &[init_config_ix(&admin.pubkey(), screener.pubkey(), TTL)],
        &[&admin],
    )
    .expect("init_registry_config");
    (h, admin, screener)
}

fn record(
    h: &mut Harness,
    screener: &Keypair,
    wallet: Pubkey,
    status: ScreeningStatus,
    source_hash: [u8; 32],
) -> Result<Executed, Failed> {
    let payer = h.payer.pubkey();
    h.send(
        &[record_ix(
            &payer,
            &screener.pubkey(),
            wallet,
            status,
            source_hash,
        )],
        &[screener],
    )
}

/// Escrow'un okuması: LiteSVM'deki hesabın kendisiyle `square_common::screening::require_clear`.
fn escrow_reads(
    h: &Harness,
    wallet: &Pubkey,
    now: i64,
) -> Result<
    square_common::contract::square_registry_contract::accounts::ScreeningRecord,
    ScreeningRejection,
> {
    let key = screening_address(wallet);
    let mut account = h.raw_account(&key).unwrap_or_default();
    let info = AccountInfo::new(
        &key,
        false,
        false,
        &mut account.lamports,
        &mut account.data,
        &account.owner,
        false,
    );
    require_clear(&info, &square_registry::ID, wallet, now)
}

#[test]
fn only_the_upgrade_authority_initializes_the_config() {
    let (mut h, admin) = deployed();
    let screener = Pubkey::new_unique();

    let stranger = h.funded(LAMPORTS);
    h.send(
        &[init_config_ix(&stranger.pubkey(), screener, TTL)],
        &[&stranger],
    )
    .expect_err("yükseltme yetkilisi olmayan")
    .assert_error(anchor_error(RegistryError::Unauthorized));
    for ttl in [0, -1] {
        h.send(&[init_config_ix(&admin.pubkey(), screener, ttl)], &[&admin])
            .expect_err("pozitif olmayan TTL")
            .assert_error(anchor_error(RegistryError::InvalidScreeningTtl));
    }
    assert!(h.raw_account(&config_address()).is_none());

    let executed = h
        .send(&[init_config_ix(&admin.pubkey(), screener, TTL)], &[&admin])
        .expect("init_registry_config");
    cu::within("registry.init_registry_config", &executed, 40_000);
    let config: RegistryConfig = h.account(&config_address()).expect("RegistryConfig");
    assert_eq!(config.admin, admin.pubkey());
    assert_eq!(config.screener_authority, screener);
    assert_eq!(config.screening_ttl_secs, TTL);
    assert_eq!(
        h.raw_account(&config_address()).unwrap().data.len(),
        RegistryConfig::SPACE
    );
    let updated: RegistryConfigUpdated = event(&executed);
    assert_eq!(
        (
            updated.admin,
            updated.screener_authority,
            updated.screening_ttl_secs
        ),
        (admin.pubkey(), screener, TTL)
    );

    // Singleton: ikinci kurulum hesabı yeniden açamaz.
    h.send(
        &[init_config_ix(&admin.pubkey(), Pubkey::new_unique(), TTL)],
        &[&admin],
    )
    .expect_err("ikinci init_registry_config");
    assert_eq!(
        h.account::<RegistryConfig>(&config_address())
            .unwrap()
            .screener_authority,
        screener
    );
}

#[test]
fn only_the_screener_records_a_screening() {
    let (mut h, _admin, screener) = configured();
    let wallet = Pubkey::new_unique();

    let stranger = h.funded(LAMPORTS);
    record(
        &mut h,
        &stranger,
        wallet,
        ScreeningStatus::Clear,
        SOURCE_HASH,
    )
    .expect_err("screener olmayan imzacı")
    .assert_error(anchor_error(RegistryError::Unauthorized));
    assert!(h.raw_account(&screening_address(&wallet)).is_none());

    // Rent'i ayrı bir payer öder (sponsor); screener'ın fonu olması gerekmez.
    assert_eq!(h.lamports(&screener.pubkey()), 0);
    let executed = record(
        &mut h,
        &screener,
        wallet,
        ScreeningStatus::Clear,
        SOURCE_HASH,
    )
    .expect("record_screening");
    cu::within_profile("registry.record_screening", &executed, "recordScreening");

    let stored: ScreeningRecord = h
        .account(&screening_address(&wallet))
        .expect("ScreeningRecord");
    assert_eq!(stored.wallet, wallet);
    assert_eq!(stored.status, ScreeningStatus::Clear);
    assert_eq!(stored.source_hash, SOURCE_HASH);
    assert_eq!(stored.screened_at, NOW);
    assert_eq!(stored.expires_at, NOW + TTL);
    assert_eq!(
        h.raw_account(&screening_address(&wallet))
            .unwrap()
            .data
            .len(),
        ScreeningRecord::SPACE
    );
    let recorded: ScreeningRecorded = event(&executed);
    assert_eq!(recorded.wallet, wallet);
    assert_eq!(recorded.status, ScreeningStatus::Clear);
    assert_eq!(recorded.source_hash, SOURCE_HASH);
    assert_eq!(recorded.expires_at, NOW + TTL);
}

#[test]
fn a_new_screening_overwrites_the_record_of_the_wallet() {
    let (mut h, _admin, screener) = configured();
    let wallet = Pubkey::new_unique();
    record(
        &mut h,
        &screener,
        wallet,
        ScreeningStatus::Clear,
        SOURCE_HASH,
    )
    .expect("ilk screening");

    h.advance(3_600);
    let flagged_hash = [0xf1; 32];
    let executed = record(
        &mut h,
        &screener,
        wallet,
        ScreeningStatus::Flagged,
        flagged_hash,
    )
    .expect("ikinci screening");
    let stored: ScreeningRecord = h.account(&screening_address(&wallet)).unwrap();
    assert_eq!(stored.status, ScreeningStatus::Flagged);
    assert_eq!(stored.source_hash, flagged_hash);
    assert_eq!(stored.screened_at, NOW + 3_600);
    assert_eq!(stored.expires_at, NOW + 3_600 + TTL);
    assert_eq!(
        event::<ScreeningRecorded>(&executed).status,
        ScreeningStatus::Flagged
    );

    // İşaret kaldırılınca kayıt yeniden temiz.
    h.advance(60);
    record(
        &mut h,
        &screener,
        wallet,
        ScreeningStatus::Clear,
        SOURCE_HASH,
    )
    .expect("üçüncü screening");
    let stored: ScreeningRecord = h.account(&screening_address(&wallet)).unwrap();
    assert_eq!(stored.status, ScreeningStatus::Clear);
    assert_eq!(stored.expires_at, NOW + 3_660 + TTL);
}

#[test]
fn the_admin_rotates_the_screener_and_the_lifetime() {
    let (mut h, admin, screener) = configured();
    let next = Keypair::new();
    let ttl = 7 * 24 * 60 * 60;

    let stranger = h.funded(LAMPORTS);
    h.send(
        &[update_config_ix(&stranger.pubkey(), next.pubkey(), ttl)],
        &[&stranger],
    )
    .expect_err("admin olmayan")
    .assert_error(anchor_error(RegistryError::Unauthorized));
    h.send(
        &[update_config_ix(&admin.pubkey(), next.pubkey(), 0)],
        &[&admin],
    )
    .expect_err("TTL 0")
    .assert_error(anchor_error(RegistryError::InvalidScreeningTtl));

    let executed = h
        .send(
            &[update_config_ix(&admin.pubkey(), next.pubkey(), ttl)],
            &[&admin],
        )
        .expect("update_registry_config");
    let config: RegistryConfig = h.account(&config_address()).unwrap();
    assert_eq!(config.admin, admin.pubkey());
    assert_eq!(config.screener_authority, next.pubkey());
    assert_eq!(config.screening_ttl_secs, ttl);
    let updated: RegistryConfigUpdated = event(&executed);
    assert_eq!(
        (
            updated.admin,
            updated.screener_authority,
            updated.screening_ttl_secs
        ),
        (admin.pubkey(), next.pubkey(), ttl)
    );

    // Eski screener artık yazamaz; yenisinin kayıtları yeni ömürle.
    let wallet = Pubkey::new_unique();
    record(
        &mut h,
        &screener,
        wallet,
        ScreeningStatus::Clear,
        SOURCE_HASH,
    )
    .expect_err("eski screener")
    .assert_error(anchor_error(RegistryError::Unauthorized));
    record(&mut h, &next, wallet, ScreeningStatus::Clear, SOURCE_HASH).expect("yeni screener");
    let stored: ScreeningRecord = h.account(&screening_address(&wallet)).unwrap();
    assert_eq!(stored.expires_at, NOW + ttl);
}

#[test]
fn escrow_accepts_the_record_only_while_it_is_clear_and_fresh() {
    let (mut h, _admin, screener) = configured();
    let wallet = Pubkey::new_unique();
    assert_eq!(
        escrow_reads(&h, &wallet, NOW).unwrap_err(),
        ScreeningRejection::Missing
    );

    record(
        &mut h,
        &screener,
        wallet,
        ScreeningStatus::Clear,
        SOURCE_HASH,
    )
    .expect("screening");
    let read = escrow_reads(&h, &wallet, NOW).expect("temiz ve taze");
    assert_eq!(read.wallet, wallet);
    assert_eq!(read.expires_at, NOW + TTL);
    assert!(escrow_reads(&h, &wallet, NOW + TTL - 1).is_ok());
    // Ömrün son saniyesi geçince kayıt bayat.
    assert_eq!(
        escrow_reads(&h, &wallet, NOW + TTL).unwrap_err(),
        ScreeningRejection::Expired
    );
    // Başka cüzdanın kaydı bu cüzdan için geçmez.
    let other = Pubkey::new_unique();
    let key = screening_address(&wallet);
    let mut account = h.raw_account(&key).unwrap();
    let info = AccountInfo::new(
        &key,
        false,
        false,
        &mut account.lamports,
        &mut account.data,
        &account.owner,
        false,
    );
    assert_eq!(
        require_clear(&info, &square_registry::ID, &other, NOW).unwrap_err(),
        ScreeningRejection::Missing
    );

    record(
        &mut h,
        &screener,
        wallet,
        ScreeningStatus::Flagged,
        SOURCE_HASH,
    )
    .expect("işaret");
    assert_eq!(
        escrow_reads(&h, &wallet, NOW).unwrap_err(),
        ScreeningRejection::Flagged
    );
}
