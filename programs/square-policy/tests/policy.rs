//! square_policy program testleri (BC-17, BC-18). Derlenmiş programı (`anchor build`) LiteSVM'de çalıştırır.

use anchor_lang::{
    AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use litesvm::{types::TransactionMetadata, LiteSVM};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::Transaction;
use square_common::seeds::{INSTITUTION_SEED, POLICY_SEED};
use square_common::{merkle, squads};
use square_policy::state::{Institution, Policy};
use square_policy::{BuyerRootCommitted, InstitutionMultisigSet, PolicyCommitted, PolicyUpdated};

use anchor_lang::prelude::{AccountMeta, Pubkey};
use anchor_lang::solana_program::instruction::Instruction;

const LAMPORTS: u64 = 10_000_000_000;

struct World {
    svm: LiteSVM,
    payer: Keypair,
    owner: Keypair,
}

fn program_path() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/square_policy.so"
    );
    assert!(
        std::path::Path::new(path).exists(),
        "program derlenmemiş: {path} (anchor build -p square_policy)"
    );
    path.to_string()
}

impl World {
    fn new(sigverify: bool) -> Self {
        let mut svm = LiteSVM::new().with_sigverify(sigverify);
        svm.add_program_from_file(square_policy::ID, program_path())
            .unwrap();
        let payer = Keypair::new();
        let owner = Keypair::new();
        svm.airdrop(&payer.pubkey(), LAMPORTS).unwrap();
        svm.airdrop(&owner.pubkey(), LAMPORTS).unwrap();
        Self { svm, payer, owner }
    }

    fn institution(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[INSTITUTION_SEED, self.owner.pubkey().as_ref()],
            &square_policy::ID,
        )
        .0
    }

    fn policy(&self, policy_id: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(
            &[POLICY_SEED, self.institution().as_ref(), policy_id],
            &square_policy::ID,
        )
        .0
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<TransactionMetadata, u32> {
        // Her işlem yeni bir blockhash ile: aynı talimat ikinci kez gönderildiğinde imza farklı olur.
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.payer.pubkey()),
            &[&[&self.payer][..], signers].concat(),
            self.svm.latest_blockhash(),
        );
        self.svm
            .send_transaction(tx)
            .map_err(|failed| custom_code(&failed.err))
    }

    /// `authority` bir PDA olduğunda (Squads vault) imza Squads programından gelir; testte imza
    /// doğrulaması kapalı LiteSVM'de imzacı olarak işaretlenir.
    fn send_as(&mut self, ix: Instruction, authority: Pubkey) -> Result<TransactionMetadata, u32> {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            &[ix],
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let signatures = message
            .account_keys
            .iter()
            .take(message.header.num_required_signatures as usize)
            .map(|key| {
                if *key == self.payer.pubkey() {
                    self.payer.sign_message(&message.serialize())
                } else {
                    assert_eq!(*key, authority);
                    Signature::default()
                }
            })
            .collect();
        self.svm
            .send_transaction(Transaction {
                signatures,
                message,
            })
            .map_err(|failed| custom_code(&failed.err))
    }

    fn account<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).expect("hesap yok");
        T::try_deserialize(&mut &account.data[..]).unwrap()
    }

    fn init_institution(&mut self, name: &str) -> Result<TransactionMetadata, u32> {
        let ix = Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::InitInstitution {
                payer: self.payer.pubkey(),
                authority: self.owner.pubkey(),
                institution: self.institution(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_policy::instruction::InitInstitution {
                name: name.to_string(),
            }
            .data(),
        };
        let owner = self.owner.insecure_clone();
        self.send(ix, &[&owner])
    }

    fn set_policy_ix(
        &self,
        authority: Pubkey,
        policy_id: [u8; 32],
        commitment: [u8; 32],
        ceiling: u64,
    ) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::SetPolicy {
                payer: self.payer.pubkey(),
                authority,
                institution: self.institution(),
                policy: self.policy(&policy_id),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_policy::instruction::SetPolicy {
                policy_id,
                commitment,
                daily_ceiling: ceiling,
            }
            .data(),
        }
    }

    fn update_policy_ix(
        &self,
        authority: Pubkey,
        policy_id: [u8; 32],
        commitment: [u8; 32],
        ceiling: u64,
    ) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::UpdatePolicy {
                authority,
                institution: self.institution(),
                policy: self.policy(&policy_id),
            }
            .to_account_metas(None),
            data: square_policy::instruction::UpdatePolicy {
                commitment,
                daily_ceiling: ceiling,
            }
            .data(),
        }
    }

    fn deactivate_ix(&self, authority: Pubkey, policy_id: [u8; 32]) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::DeactivatePolicy {
                authority,
                institution: self.institution(),
                policy: self.policy(&policy_id),
            }
            .to_account_metas(None),
            data: square_policy::instruction::DeactivatePolicy {}.data(),
        }
    }

    fn set_buyer_root_ix(
        &self,
        authority: Pubkey,
        policy_id: [u8; 32],
        root: [u8; 32],
    ) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::SetBuyerRoot {
                authority,
                institution: self.institution(),
                policy: self.policy(&policy_id),
            }
            .to_account_metas(None),
            data: square_policy::instruction::SetBuyerRoot { buyer_root: root }.data(),
        }
    }

    fn set_multisig_ix(
        &self,
        authority: Pubkey,
        multisig: Pubkey,
        account: Pubkey,
        vault_index: u8,
    ) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::SetInstitutionMultisig {
                authority,
                institution: self.institution(),
                squads_multisig: account,
            }
            .to_account_metas(None),
            data: square_policy::instruction::SetInstitutionMultisig {
                multisig,
                vault_index,
            }
            .data(),
        }
    }

    /// Squads v4'e ait, başlatılmış bir `Multisig` hesabı (test fikstürü).
    fn squads_multisig(&mut self, owner: Pubkey, discriminator: [u8; 8]) -> Pubkey {
        let address = Keypair::new().pubkey();
        let mut data = discriminator.to_vec();
        data.extend_from_slice(&[0; 64]);
        self.svm
            .set_account(
                address,
                Account {
                    lamports: LAMPORTS,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        address
    }
}

fn custom_code(err: &solana_transaction::TransactionError) -> u32 {
    match err {
        solana_transaction::TransactionError::InstructionError(
            _,
            solana_instruction_error::InstructionError::Custom(code),
        ) => *code,
        other => panic!("beklenmeyen hata: {other:?}"),
    }
}

/// İşlem log'larındaki `Program data:` satırlarından `E` event'ini çözer.
fn event<E: AnchorDeserialize + Discriminator>(meta: &TransactionMetadata) -> E {
    meta.logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .map(|data| BASE64.decode(data).unwrap())
        .find(|bytes| bytes.starts_with(E::DISCRIMINATOR))
        .map(|bytes| E::try_from_slice(&bytes[E::DISCRIMINATOR.len()..]).unwrap())
        .expect("event yayımlanmadı")
}

const UNAUTHORIZED: u32 = 6000;
const NAME_TOO_LONG: u32 = 6001;
const POLICY_INACTIVE: u32 = 6002;
const INVALID_DAILY_CEILING: u32 = 6003;
const INVALID_SQUADS_MULTISIG: u32 = 6004;

const POLICY_ID: [u8; 32] = [7; 32];
const COMMITMENT: [u8; 32] = [42; 32];
const CEILING: u64 = 1_000_000_000;

#[test]
fn set_policy_stores_only_commitment_and_public_ceiling() {
    let mut w = World::new(true);
    w.init_institution("Research procurement").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    let ix = w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING);
    // Talimat verisi: discriminator + policy_id + commitment + tavan. Politikanın kendisi taşınmaz.
    assert_eq!(ix.data.len(), 8 + 32 + 32 + 8);
    let meta = w.send(ix, &[&owner_kp]).unwrap();

    let policy: Policy = w.account(&w.policy(&POLICY_ID));
    assert_eq!(policy.institution, w.institution());
    assert_eq!(policy.policy_id, POLICY_ID);
    assert_eq!(policy.commitment, COMMITMENT);
    assert_eq!(policy.daily_ceiling, CEILING);
    assert_eq!(policy.buyer_root, [0; 32]);
    assert_eq!(policy.version, 1);
    assert!(policy.active);
    // Hesap düzeni sabit boyutlu; politika alanları için yer yok.
    assert_eq!(
        w.svm.get_account(&w.policy(&POLICY_ID)).unwrap().data.len(),
        Policy::SPACE
    );

    let institution: Institution = w.account(&w.institution());
    assert_eq!(institution.owner_key, owner);
    assert_eq!(institution.policy_count, 1);
    assert_eq!(institution.name, "Research procurement");

    let committed: PolicyCommitted = event(&meta);
    assert_eq!(committed.policy, w.policy(&POLICY_ID));
    assert_eq!(committed.commitment, COMMITMENT);
    assert_eq!(committed.daily_ceiling, CEILING);
    assert_eq!(committed.version, 1);
}

#[test]
fn update_increments_version_each_time() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    w.send(
        w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
        &[&owner_kp],
    )
    .unwrap();

    for (version, ceiling) in [(2u32, 2 * CEILING), (3, 3 * CEILING)] {
        let commitment = [version as u8; 32];
        let meta = w
            .send(
                w.update_policy_ix(owner, POLICY_ID, commitment, ceiling),
                &[&owner_kp],
            )
            .unwrap();
        let policy: Policy = w.account(&w.policy(&POLICY_ID));
        assert_eq!(policy.version, version);
        assert_eq!(policy.commitment, commitment);
        assert_eq!(policy.daily_ceiling, ceiling);
        assert!(policy.updated_at >= policy.created_at);
        let updated: PolicyUpdated = event(&meta);
        assert_eq!((updated.version, updated.daily_ceiling), (version, ceiling));
    }
}

#[test]
fn rejects_zero_ceiling_long_name_and_foreign_signer() {
    let mut w = World::new(true);
    assert_eq!(
        w.init_institution(&"x".repeat(65)).unwrap_err(),
        NAME_TOO_LONG
    );
    w.init_institution(&"x".repeat(64)).unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    assert_eq!(
        w.send(
            w.set_policy_ix(owner, POLICY_ID, COMMITMENT, 0),
            &[&owner_kp]
        )
        .unwrap_err(),
        INVALID_DAILY_CEILING
    );
    w.send(
        w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
        &[&owner_kp],
    )
    .unwrap();
    assert_eq!(
        w.send(
            w.update_policy_ix(owner, POLICY_ID, COMMITMENT, 0),
            &[&owner_kp]
        )
        .unwrap_err(),
        INVALID_DAILY_CEILING
    );

    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), LAMPORTS).unwrap();
    let other_id = [8; 32];
    assert_eq!(
        w.send(
            w.set_policy_ix(stranger.pubkey(), other_id, COMMITMENT, CEILING),
            &[&stranger]
        )
        .unwrap_err(),
        UNAUTHORIZED
    );
    assert_eq!(
        w.send(
            w.update_policy_ix(stranger.pubkey(), POLICY_ID, COMMITMENT, CEILING),
            &[&stranger]
        )
        .unwrap_err(),
        UNAUTHORIZED
    );
    assert_eq!(
        w.send(w.deactivate_ix(stranger.pubkey(), POLICY_ID), &[&stranger])
            .unwrap_err(),
        UNAUTHORIZED
    );
}

#[test]
fn deactivated_policy_cannot_be_updated() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    w.send(
        w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
        &[&owner_kp],
    )
    .unwrap();
    w.send(w.deactivate_ix(owner, POLICY_ID), &[&owner_kp])
        .unwrap();
    let policy: Policy = w.account(&w.policy(&POLICY_ID));
    assert!(!policy.active);
    assert_eq!(policy.version, 1);
    assert_eq!(
        w.send(
            w.update_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
            &[&owner_kp]
        )
        .unwrap_err(),
        POLICY_INACTIVE
    );
    assert_eq!(
        w.send(w.deactivate_ix(owner, POLICY_ID), &[&owner_kp])
            .unwrap_err(),
        POLICY_INACTIVE
    );
}

#[test]
fn multisig_binding_requires_a_squads_multisig() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();

    let not_squads = w.squads_multisig(Pubkey::new_unique(), squads::MULTISIG_DISCRIMINATOR);
    assert_eq!(
        w.send(
            w.set_multisig_ix(owner, not_squads, not_squads, 0),
            &[&owner_kp]
        )
        .unwrap_err(),
        INVALID_SQUADS_MULTISIG
    );
    let other_type = w.squads_multisig(squads::PROGRAM_ID, [1; 8]);
    assert_eq!(
        w.send(
            w.set_multisig_ix(owner, other_type, other_type, 0),
            &[&owner_kp]
        )
        .unwrap_err(),
        INVALID_SQUADS_MULTISIG
    );
    let multisig = w.squads_multisig(squads::PROGRAM_ID, squads::MULTISIG_DISCRIMINATOR);
    // Hesap argümandaki multisig değil.
    assert_eq!(
        w.send(
            w.set_multisig_ix(owner, Pubkey::new_unique(), multisig, 0),
            &[&owner_kp]
        )
        .unwrap_err(),
        INVALID_SQUADS_MULTISIG
    );

    let meta = w
        .send(
            w.set_multisig_ix(owner, multisig, multisig, 1),
            &[&owner_kp],
        )
        .unwrap();
    let institution: Institution = w.account(&w.institution());
    assert_eq!(institution.multisig, Some(multisig));
    assert_eq!(
        institution.multisig_vault,
        Some(squads::vault_address(&multisig, 1))
    );
    let set: InstitutionMultisigSet = event(&meta);
    assert_eq!(set.multisig_vault, squads::vault_address(&multisig, 1));
}

#[test]
fn after_binding_only_the_vault_is_authority() {
    let mut w = World::new(false);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    w.send(
        w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
        &[&owner_kp],
    )
    .unwrap();
    let multisig = w.squads_multisig(squads::PROGRAM_ID, squads::MULTISIG_DISCRIMINATOR);
    w.send(
        w.set_multisig_ix(owner, multisig, multisig, 0),
        &[&owner_kp],
    )
    .unwrap();
    let vault = squads::vault_address(&multisig, 0);

    // Kurum anahtarı artık yetkili değil.
    assert_eq!(
        w.send(
            w.update_policy_ix(owner, POLICY_ID, COMMITMENT, 2 * CEILING),
            &[&owner_kp]
        )
        .unwrap_err(),
        UNAUTHORIZED
    );
    assert_eq!(
        w.send(
            w.set_policy_ix(owner, [9; 32], COMMITMENT, CEILING),
            &[&owner_kp]
        )
        .unwrap_err(),
        UNAUTHORIZED
    );
    assert_eq!(
        w.send(
            w.set_multisig_ix(owner, multisig, multisig, 2),
            &[&owner_kp]
        )
        .unwrap_err(),
        UNAUTHORIZED
    );

    // Vault yetkili: güncelleme, yeni politika ve yeniden bağlama.
    w.send_as(
        w.update_policy_ix(vault, POLICY_ID, [5; 32], 2 * CEILING),
        vault,
    )
    .unwrap();
    assert_eq!(w.account::<Policy>(&w.policy(&POLICY_ID)).version, 2);
    w.send_as(w.set_policy_ix(vault, [9; 32], COMMITMENT, CEILING), vault)
        .unwrap();
    assert_eq!(w.account::<Institution>(&w.institution()).policy_count, 2);
    let next = w.squads_multisig(squads::PROGRAM_ID, squads::MULTISIG_DISCRIMINATOR);
    w.send_as(w.set_multisig_ix(vault, next, next, 0), vault)
        .unwrap();
    assert_eq!(
        w.account::<Institution>(&w.institution()).multisig_vault,
        Some(squads::vault_address(&next, 0))
    );
    // Eski vault artık yetkili değil.
    assert_eq!(
        w.send_as(w.deactivate_ix(vault, POLICY_ID), vault)
            .unwrap_err(),
        UNAUTHORIZED
    );
}

/// İki alıcılı liste: kök ve ilk alıcının kanıtı (`merkle` modülünün kurallarıyla).
fn two_buyer_list() -> ([u8; 32], Pubkey, [u8; 32], [u8; 32]) {
    let (buyer, salt) = (Pubkey::new_unique(), [3; 32]);
    let other = merkle::buyer_leaf(&Pubkey::new_unique(), &[4; 32]);
    let root = merkle::parent(&merkle::buyer_leaf(&buyer, &salt), &other);
    (root, buyer, salt, other)
}

#[test]
fn owner_publishes_buyer_root_and_proofs_verify_against_it() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    w.send(
        w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
        &[&owner_kp],
    )
    .unwrap();
    let address = w.policy(&POLICY_ID);
    assert!(merkle::is_unrestricted(
        &w.account::<Policy>(&address).buyer_root
    ));

    let (root, buyer, salt, sibling) = two_buyer_list();
    let meta = w
        .send(w.set_buyer_root_ix(owner, POLICY_ID, root), &[&owner_kp])
        .unwrap();
    let policy: Policy = w.account(&address);
    assert_eq!(policy.buyer_root, root);
    // Kök job snapshot'ına girmez; politika sürümü değişmez.
    assert_eq!(policy.version, 1);
    let committed: BuyerRootCommitted = event(&meta);
    assert_eq!(committed.policy, address);
    assert_eq!(committed.buyer_root, root);
    assert!(merkle::verify_buyer_proof(
        &policy.buyer_root,
        &buyer,
        &salt,
        &[sibling]
    ));
    assert!(!merkle::verify_buyer_proof(
        &policy.buyer_root,
        &Pubkey::new_unique(),
        &salt,
        &[sibling]
    ));

    // Sıfır kök kısıtı kaldırır.
    w.send(
        w.set_buyer_root_ix(owner, POLICY_ID, merkle::UNRESTRICTED_ROOT),
        &[&owner_kp],
    )
    .unwrap();
    assert!(merkle::is_unrestricted(
        &w.account::<Policy>(&address).buyer_root
    ));
}

#[test]
fn buyer_root_rejects_foreign_signer_and_inactive_policy() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    w.send(
        w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
        &[&owner_kp],
    )
    .unwrap();
    let (root, ..) = two_buyer_list();

    let stranger = Keypair::new();
    assert_eq!(
        w.send(
            w.set_buyer_root_ix(stranger.pubkey(), POLICY_ID, root),
            &[&stranger]
        )
        .unwrap_err(),
        UNAUTHORIZED
    );
    assert!(merkle::is_unrestricted(
        &w.account::<Policy>(&w.policy(&POLICY_ID)).buyer_root
    ));

    w.send(w.deactivate_ix(owner, POLICY_ID), &[&owner_kp])
        .unwrap();
    assert_eq!(
        w.send(w.set_buyer_root_ix(owner, POLICY_ID, root), &[&owner_kp])
            .unwrap_err(),
        POLICY_INACTIVE
    );
}

#[test]
fn after_binding_only_the_vault_sets_buyer_root() {
    let mut w = World::new(false);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    let owner_kp = w.owner.insecure_clone();
    w.send(
        w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING),
        &[&owner_kp],
    )
    .unwrap();
    let multisig = w.squads_multisig(squads::PROGRAM_ID, squads::MULTISIG_DISCRIMINATOR);
    w.send(
        w.set_multisig_ix(owner, multisig, multisig, 0),
        &[&owner_kp],
    )
    .unwrap();
    let vault = squads::vault_address(&multisig, 0);
    let (root, ..) = two_buyer_list();

    assert_eq!(
        w.send(w.set_buyer_root_ix(owner, POLICY_ID, root), &[&owner_kp])
            .unwrap_err(),
        UNAUTHORIZED
    );
    w.send_as(w.set_buyer_root_ix(vault, POLICY_ID, root), vault)
        .unwrap();
    assert_eq!(w.account::<Policy>(&w.policy(&POLICY_ID)).buyer_root, root);
}

#[test]
fn account_meta_order_matches_contract() {
    let w = World::new(true);
    let metas = w
        .set_multisig_ix(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            0,
        )
        .accounts;
    let flags: Vec<(bool, bool)> = metas
        .iter()
        .map(|m: &AccountMeta| (m.is_signer, m.is_writable))
        .collect();
    assert_eq!(flags, vec![(true, false), (false, true), (false, false)]);
}
