//! Square programlarının LiteSVM test altyapısı (BC-12).
//!
//! Programlar Agave'nin SBF çalışma zamanında, süreç içinde koşar: `anchor build`'in ürettiği
//! `target/deploy/<program>.so` dosyaları yüklenir, validator gerekmez. Instruction'lar ve hesaplar
//! programların kendi crate'lerinden (`no-entrypoint`) kurulur; arayüz değişince testler derlenmez.
//!
//! - [`Harness`]: programları yükler, işlem gönderir, hesap okur, saati yönetir.
//! - [`token`]: mint, associated token account ve basım fikstürleri (SPL Token programının kendisiyle).
//! - [`squads`]: Squads v4 multisig hesabı ve vault imzacısı.
//! - [`Executed::compute_units`]: compute unit ölçümü; [`cu`] bütçe denetimi ve rapor satırı.

pub mod squads;
pub mod token;

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::AccountDeserialize;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_loader_v3_interface::state::UpgradeableLoaderState;
use solana_message::{Message, VersionedMessage};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;

pub use litesvm;

/// Bir işlemin başarıyla işlenmesi.
#[derive(Debug)]
pub struct Executed {
    pub compute_units: u64,
    pub logs: Vec<String>,
}

/// Reddedilen işlem: hata, loglar ve reddedilene kadar harcanan compute unit.
#[derive(Debug)]
pub struct Failed {
    pub error: TransactionError,
    pub logs: Vec<String>,
    pub compute_units: u64,
}

impl Failed {
    /// `InstructionError::Custom` kodu (Anchor hataları 6000'den başlar).
    pub fn custom_code(&self) -> Option<u32> {
        match &self.error {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(*code),
            _ => None,
        }
    }

    /// İşlem tam olarak bu Anchor hatasıyla reddedildi mi; değilse hatayı ve logları gösterir.
    #[track_caller]
    pub fn assert_error(&self, expected: impl Into<u32>) {
        let expected = expected.into();
        assert_eq!(
            self.custom_code(),
            Some(expected),
            "beklenen hata kodu {expected}, gelen {:?}\n{}",
            self.error,
            self.logs.join("\n")
        );
    }
}

pub type Outcome = Result<Executed, Failed>;

/// Derlenmiş programların dizini: `SBF_OUT_DIR`, yoksa kök workspace'in `target/deploy`'u.
pub fn sbf_out_dir() -> PathBuf {
    std::env::var_os("SBF_OUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy"))
}

fn program_bytes(name: &str) -> Vec<u8> {
    let path = sbf_out_dir().join(format!("{name}.so"));
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{} okunamadı ({e}). Programlar önce derlenmeli: repo kökünde `anchor build` (ya da SBF_OUT_DIR)",
            path.display()
        )
    })
}

pub struct Harness {
    pub svm: LiteSVM,
    /// İşlem ücretlerini ve kira bedellerini ödeyen hesap.
    pub payer: Keypair,
    sigverify: bool,
}

impl Harness {
    /// İmzaları doğrulayan ortam; SPL Token, Token-2022 ve ATA programları yüklüdür.
    pub fn new() -> Self {
        Self::build(true)
    }

    /// İmza doğrulamasız ortam: PDA'lar (ör. Squads vault) imzacı olarak işlem gönderebilir
    /// ([`Harness::send_as`]). Program kısıtları yine tam olarak uygulanır.
    pub fn without_sigverify() -> Self {
        Self::build(false)
    }

    fn build(sigverify: bool) -> Self {
        let mut svm = LiteSVM::new().with_sigverify(sigverify);
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000)
            .expect("payer airdrop");
        Self {
            svm,
            payer,
            sigverify,
        }
    }

    /// `target/deploy/<name>.so`'yu `program_id` adresine yükler (yükseltme yetkisi yok).
    pub fn deploy(&mut self, name: &str, program_id: Pubkey) -> &mut Self {
        self.svm
            .add_program(program_id, &program_bytes(name))
            .unwrap_or_else(|e| panic!("{name} yüklenemedi: {e:?}"));
        self
    }

    /// Programı yükseltilebilir loader'la, `authority` yükseltme yetkilisi olarak yükler. Yetkiliyi
    /// `ProgramData`'dan doğrulayan instruction'lar (ör. escrow `init_config`) için.
    pub fn deploy_upgradeable(
        &mut self,
        name: &str,
        program_id: Pubkey,
        authority: Pubkey,
    ) -> &mut Self {
        self.deploy(name, program_id);
        let programdata = programdata_address(&program_id);
        let mut account = self
            .svm
            .get_account(&programdata)
            .expect("ProgramData hesabı");
        write_upgrade_authority(&mut account.data, authority);
        self.svm
            .set_account(programdata, account)
            .expect("ProgramData yazılamadı");
        self
    }

    /// `lamports` ile fonlanmış yeni bir anahtar.
    pub fn funded(&mut self, lamports: u64) -> Keypair {
        let keypair = Keypair::new();
        self.svm
            .airdrop(&keypair.pubkey(), lamports)
            .expect("airdrop");
        keypair
    }

    /// Ücreti `payer` öder; `signers` ek imzacılardır. Her işlem taze bir blockhash'le gönderilir,
    /// böylece aynı instruction'ları tekrarlayan işlemler `AlreadyProcessed` ile düşmez.
    pub fn send(&mut self, instructions: &[Instruction], signers: &[&Keypair]) -> Outcome {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let mut all: Vec<&Keypair> = vec![&self.payer];
        all.extend(
            signers
                .iter()
                .copied()
                .filter(|s| s.pubkey() != self.payer.pubkey()),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &all)
            .expect("işlem imzalanamadı");
        self.submit(tx)
    }

    /// İmza doğrulamasız ortamda, anahtarı olmayan imzacılarla (PDA) gönderir. `keypairs` gerçekten
    /// imzalar; `pdas` imzacı olarak işaretlenir, imzaları boş kalır.
    pub fn send_as(
        &mut self,
        instructions: &[Instruction],
        keypairs: &[&Keypair],
        pdas: &[Pubkey],
    ) -> Outcome {
        assert!(
            !self.sigverify,
            "send_as yalnızca Harness::without_sigverify ortamında kullanılır"
        );
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let signer_keys = &message.account_keys[..message.header.num_required_signatures as usize];
        let signatures = signer_keys
            .iter()
            .map(|key| {
                let keypair = std::iter::once(&self.payer)
                    .chain(keypairs.iter().copied())
                    .find(|k| k.pubkey() == *key);
                match keypair {
                    Some(k) => k.sign_message(&message.serialize()),
                    None if pdas.contains(key) => Signature::default(),
                    None => panic!("{key} imzacı ama ne anahtarı ne de PDA olarak verildi"),
                }
            })
            .collect();
        let tx = VersionedTransaction {
            signatures,
            message: VersionedMessage::Legacy(message),
        };
        self.submit(tx)
    }

    fn submit(&mut self, tx: VersionedTransaction) -> Outcome {
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(Executed {
                compute_units: meta.compute_units_consumed,
                logs: meta.logs,
            }),
            Err(failed) => Err(Failed {
                error: failed.err,
                logs: failed.meta.logs,
                compute_units: failed.meta.compute_units_consumed,
            }),
        }
    }

    /// Anchor hesabını çözer (discriminator denetimiyle); hesap yoksa None.
    pub fn account<T: AccountDeserialize>(&self, address: &Pubkey) -> Option<T> {
        let account = self.svm.get_account(address)?;
        if account.data.is_empty() {
            return None;
        }
        Some(
            T::try_deserialize(&mut account.data.as_slice())
                .unwrap_or_else(|e| panic!("{address} çözülemedi: {e}")),
        )
    }

    pub fn raw_account(&self, address: &Pubkey) -> Option<Account> {
        self.svm.get_account(address)
    }

    pub fn set_account(&mut self, address: Pubkey, account: Account) {
        self.svm
            .set_account(address, account)
            .expect("hesap yazılamadı");
    }

    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_balance(address).unwrap_or(0)
    }

    /// Clock sysvar'ının Unix zamanı.
    pub fn now(&self) -> i64 {
        self.svm
            .get_sysvar::<anchor_lang::prelude::Clock>()
            .unix_timestamp
    }

    /// Saati verilen Unix zamanına kurar; slot bir artar.
    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        clock.unix_timestamp = unix_timestamp;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    /// Saati `seconds` saniye ilerletir (ör. challenge penceresinin sonuna).
    pub fn advance(&mut self, seconds: i64) {
        self.set_time(self.now() + seconds);
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

/// Yükseltilebilir loader'da programın `ProgramData` adresi.
pub fn programdata_address(program_id: &Pubkey) -> Pubkey {
    solana_loader_v3_interface::get_program_data_address(program_id)
}

/// `ProgramData` meta verisi, loader'ın bincode düzeninde: `u32` etiket (3 = ProgramData), `u64` slot,
/// `Option<Pubkey>` yükseltme yetkilisi (1 bayt + 32 bayt); ardından ELF.
fn write_upgrade_authority(data: &mut [u8], authority: Pubkey) {
    const PROGRAMDATA_TAG: u32 = 3;
    assert_eq!(
        UpgradeableLoaderState::size_of_programdata_metadata(),
        4 + 8 + 1 + 32
    );
    assert_eq!(
        u32::from_le_bytes(data[..4].try_into().unwrap()),
        PROGRAMDATA_TAG,
        "ProgramData hesabı değil"
    );
    data[12] = 1;
    data[13..45].copy_from_slice(authority.as_ref());
}

/// Anchor `#[error_code]` hatasının işlemde görünen kodu (6000 + sıra).
pub fn anchor_error<E>(error: E) -> u32
where
    E: Into<anchor_lang::error::Error>,
{
    match error.into() {
        anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
        anchor_lang::error::Error::ProgramError(e) => panic!("Anchor hatası değil: {e:?}"),
    }
}

/// Compute unit bütçeleri ve rapor.
pub mod cu {
    use super::Executed;

    /// Ölçülen compute unit'i `[cu] <etiket>: <değer> / <bütçe>` biçiminde yazar (`cargo test -- --nocapture`)
    /// ve bütçeyi aşarsa testi düşürür.
    #[track_caller]
    pub fn within(label: &str, executed: &Executed, budget: u64) -> u64 {
        println!("[cu] {label}: {} / {budget}", executed.compute_units);
        assert!(
            executed.compute_units <= budget,
            "{label}: {} compute unit, bütçe {budget}",
            executed.compute_units
        );
        executed.compute_units
    }
}
