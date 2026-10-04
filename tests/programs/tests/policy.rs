//! square_policy program testleri (BC-17, BC-18; sözleşme arayüzü): kurum, politika commitment'ı ve alıcı
//! listesi kökü; Squads multisig bağlanınca yetkili yalnızca vault PDA'sı olur.

use anchor_lang::prelude::{AccountMeta, Pubkey};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::merkle;
use square_common::seeds::{INSTITUTION_SEED, POLICY_SEED};
use square_common::squads::{
    vault_address, MULTISIG_DISCRIMINATOR, PROGRAM_ID as SQUADS_PROGRAM_ID,
};
use square_policy::errors::PolicyError;
use square_policy::state::{Institution, Policy};
use square_policy::{BuyerRootCommitted, InstitutionMultisigSet, PolicyCommitted, PolicyUpdated};
use square_program_tests::squads::{self, SquadsMultisig};
use square_program_tests::{anchor_error, cu, event, Executed, Failed, Harness};

const LAMPORTS: u64 = 10_000_000_000;
const POLICY_ID: [u8; 32] = [7; 32];
const COMMITMENT: [u8; 32] = [42; 32];
const CEILING: u64 = 1_000_000_000; // 1 000 USDC

struct World {
    h: Harness,
    owner: Keypair,
}

impl World {
    /// `sigverify = false`: Squads vault'u (PDA) imzacı olarak kullanılabilir (`send_as`).
    fn new(sigverify: bool) -> Self {
        let mut h = if sigverify {
            Harness::new()
        } else {
            Harness::without_sigverify()
        };
        h.deploy("square_policy", square_policy::ID);
        let owner = h.funded(LAMPORTS);
        Self { h, owner }
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

    fn institution_account(&self) -> Institution {
        self.h.account(&self.institution()).expect("Institution")
    }

    fn policy_account(&self, policy_id: &[u8; 32]) -> Policy {
        self.h.account(&self.policy(policy_id)).expect("Policy")
    }

    /// Kurum sahibinin imzasıyla.
    fn send_owner(&mut self, ix: Instruction) -> Result<Executed, Failed> {
        let owner = self.owner.insecure_clone();
        self.h.send(&[ix], &[&owner])
    }

    /// Squads vault'unun (PDA) imzasıyla; imza Squads programından gelir.
    fn send_vault(&mut self, ix: Instruction, vault: Pubkey) -> Result<Executed, Failed> {
        self.h.send_as(&[ix], &[], &[vault])
    }

    fn init_institution(&mut self, name: &str) -> Result<Executed, Failed> {
        let ix = Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::InitInstitution {
                payer: self.h.payer.pubkey(),
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
        self.send_owner(ix)
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
                payer: self.h.payer.pubkey(),
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

    /// `multisig` talimat argümanı, `account` hesap listesindeki `squads_multisig`.
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
}

#[test]
fn set_policy_stores_only_commitment_and_public_ceiling() {
    let mut w = World::new(true);
    w.init_institution("Research procurement").unwrap();
    let owner = w.owner.pubkey();
    let ix = w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING);
    // Talimat verisi: discriminator + policy_id + commitment + tavan. Politikanın kendisi taşınmaz.
    assert_eq!(ix.data.len(), 8 + 32 + 32 + 8);
    let executed = w.send_owner(ix).unwrap();
    cu::within("policy.set_policy", &executed, 40_000);

    let policy = w.policy_account(&POLICY_ID);
    assert_eq!(policy.institution, w.institution());
    assert_eq!(policy.policy_id, POLICY_ID);
    assert_eq!(policy.commitment, COMMITMENT);
    assert_eq!(policy.daily_ceiling, CEILING);
    assert_eq!(policy.buyer_root, [0; 32]);
    assert_eq!(policy.version, 1);
    assert!(policy.active);
    // Hesap düzeni sabit boyutlu; politika alanları için yer yok.
    assert_eq!(
        w.h.raw_account(&w.policy(&POLICY_ID)).unwrap().data.len(),
        Policy::SPACE
    );

    let institution = w.institution_account();
    assert_eq!(institution.owner_key, owner);
    assert_eq!(institution.authority(), owner);
    assert_eq!(institution.policy_count, 1);
    assert_eq!(institution.name, "Research procurement");

    let committed: PolicyCommitted = event(&executed);
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
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .unwrap();

    for (version, ceiling) in [(2u32, 2 * CEILING), (3, 3 * CEILING)] {
        let commitment = [version as u8; 32];
        let executed = w
            .send_owner(w.update_policy_ix(owner, POLICY_ID, commitment, ceiling))
            .unwrap();
        cu::within("policy.update_policy", &executed, 20_000);
        let policy = w.policy_account(&POLICY_ID);
        assert_eq!(policy.version, version);
        assert_eq!(policy.commitment, commitment);
        assert_eq!(policy.daily_ceiling, ceiling);
        assert!(policy.updated_at >= policy.created_at);
        let updated: PolicyUpdated = event(&executed);
        assert_eq!((updated.version, updated.daily_ceiling), (version, ceiling));
    }
}

#[test]
fn rejects_zero_ceiling_long_name_and_foreign_signer() {
    let mut w = World::new(true);
    w.init_institution(&"x".repeat(65))
        .expect_err("65 baytlık ad")
        .assert_error(anchor_error(PolicyError::NameTooLong));
    w.init_institution(&"x".repeat(64)).unwrap();
    let owner = w.owner.pubkey();
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, 0))
        .expect_err("tavan 0")
        .assert_error(anchor_error(PolicyError::InvalidDailyCeiling));
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .unwrap();
    w.send_owner(w.update_policy_ix(owner, POLICY_ID, COMMITMENT, 0))
        .expect_err("güncellemede tavan 0")
        .assert_error(anchor_error(PolicyError::InvalidDailyCeiling));

    let stranger = w.h.funded(LAMPORTS);
    let other_id = [8; 32];
    for ix in [
        w.set_policy_ix(stranger.pubkey(), other_id, COMMITMENT, CEILING),
        w.update_policy_ix(stranger.pubkey(), POLICY_ID, COMMITMENT, CEILING),
        w.deactivate_ix(stranger.pubkey(), POLICY_ID),
    ] {
        w.h.send(&[ix], &[&stranger])
            .expect_err("yabancı imzacı")
            .assert_error(anchor_error(PolicyError::Unauthorized));
    }
}

#[test]
fn deactivated_policy_cannot_be_updated() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .unwrap();
    w.send_owner(w.deactivate_ix(owner, POLICY_ID)).unwrap();
    let policy = w.policy_account(&POLICY_ID);
    assert!(!policy.active);
    assert_eq!(policy.version, 1);
    w.send_owner(w.update_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .expect_err("kapalı politika güncellenmez")
        .assert_error(anchor_error(PolicyError::PolicyInactive));
    w.send_owner(w.deactivate_ix(owner, POLICY_ID))
        .expect_err("kapalı politika yeniden kapatılmaz")
        .assert_error(anchor_error(PolicyError::PolicyInactive));
}

#[test]
fn multisig_binding_requires_a_squads_multisig() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();

    let mut multisig_data = MULTISIG_DISCRIMINATOR.to_vec();
    multisig_data.extend_from_slice(&[0; 32]);
    // Multisig discriminator'ı taşıyan ama Squads'a ait olmayan hesap; Squads'a ait ama Multisig olmayan hesap.
    let not_squads = squads::write_account(&mut w.h, multisig_data, Pubkey::new_unique());
    let other_type = squads::write_account(&mut w.h, vec![1; 40], SQUADS_PROGRAM_ID);
    for account in [not_squads, other_type] {
        w.send_owner(w.set_multisig_ix(owner, account, account, 0))
            .expect_err("geçersiz multisig")
            .assert_error(anchor_error(PolicyError::InvalidSquadsMultisig));
    }
    let multisig = SquadsMultisig::create(&mut w.h);
    // Hesap argümandaki multisig değil.
    w.send_owner(w.set_multisig_ix(owner, Pubkey::new_unique(), multisig.address, 0))
        .expect_err("argüman / hesap uyuşmazlığı")
        .assert_error(anchor_error(PolicyError::InvalidSquadsMultisig));

    let executed = w
        .send_owner(w.set_multisig_ix(owner, multisig.address, multisig.address, 1))
        .unwrap();
    cu::within("policy.set_institution_multisig", &executed, 20_000);
    let institution = w.institution_account();
    assert_eq!(institution.multisig, Some(multisig.address));
    assert_eq!(institution.multisig_vault, Some(multisig.vault(1)));
    assert_eq!(institution.authority(), multisig.vault(1));
    let set: InstitutionMultisigSet = event(&executed);
    assert_eq!(set.multisig_vault, vault_address(&multisig.address, 1));
}

#[test]
fn after_binding_only_the_vault_is_authority() {
    let mut w = World::new(false);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .unwrap();
    let multisig = SquadsMultisig::create(&mut w.h);
    w.send_owner(w.set_multisig_ix(owner, multisig.address, multisig.address, 0))
        .unwrap();
    let vault = multisig.vault(0);

    // Kurum anahtarı artık yetkili değil.
    for ix in [
        w.update_policy_ix(owner, POLICY_ID, COMMITMENT, 2 * CEILING),
        w.set_policy_ix(owner, [9; 32], COMMITMENT, CEILING),
        w.set_multisig_ix(owner, multisig.address, multisig.address, 2),
    ] {
        w.send_owner(ix)
            .expect_err("multisig sonrası sahip")
            .assert_error(anchor_error(PolicyError::Unauthorized));
    }

    // Vault yetkili: güncelleme, yeni politika ve yeniden bağlama.
    w.send_vault(
        w.update_policy_ix(vault, POLICY_ID, [5; 32], 2 * CEILING),
        vault,
    )
    .unwrap();
    assert_eq!(w.policy_account(&POLICY_ID).version, 2);
    w.send_vault(w.set_policy_ix(vault, [9; 32], COMMITMENT, CEILING), vault)
        .unwrap();
    assert_eq!(w.policy_account(&[9; 32]).daily_ceiling, CEILING);
    assert_eq!(w.institution_account().policy_count, 2);
    let next = SquadsMultisig::create(&mut w.h);
    w.send_vault(
        w.set_multisig_ix(vault, next.address, next.address, 0),
        vault,
    )
    .unwrap();
    assert_eq!(w.institution_account().multisig_vault, Some(next.vault(0)));
    // Eski vault artık yetkili değil.
    w.send_vault(w.deactivate_ix(vault, POLICY_ID), vault)
        .expect_err("eski vault")
        .assert_error(anchor_error(PolicyError::Unauthorized));
}

/// İki alıcılı liste: kök ve ilk alıcının kanıtı (`merkle` modülünün kurallarıyla).
fn two_buyer_list() -> ([u8; 32], Pubkey, [u8; 32], [u8; 32]) {
    let (buyer, salt) = (Pubkey::new_unique(), [3; 32]);
    let sibling = merkle::buyer_leaf(&Pubkey::new_unique(), &[4; 32]);
    let root = merkle::parent(&merkle::buyer_leaf(&buyer, &salt), &sibling);
    (root, buyer, salt, sibling)
}

#[test]
fn owner_publishes_buyer_root_and_proofs_verify_against_it() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .unwrap();
    assert!(merkle::is_unrestricted(
        &w.policy_account(&POLICY_ID).buyer_root
    ));

    let (root, buyer, salt, sibling) = two_buyer_list();
    let executed = w
        .send_owner(w.set_buyer_root_ix(owner, POLICY_ID, root))
        .unwrap();
    cu::within("policy.set_buyer_root", &executed, 20_000);
    let policy = w.policy_account(&POLICY_ID);
    assert_eq!(policy.buyer_root, root);
    // Kök job snapshot'ına girmez; politika sürümü değişmez.
    assert_eq!(policy.version, 1);
    let committed: BuyerRootCommitted = event(&executed);
    assert_eq!(committed.policy, w.policy(&POLICY_ID));
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
    w.send_owner(w.set_buyer_root_ix(owner, POLICY_ID, merkle::UNRESTRICTED_ROOT))
        .unwrap();
    assert!(merkle::is_unrestricted(
        &w.policy_account(&POLICY_ID).buyer_root
    ));
}

#[test]
fn buyer_root_rejects_foreign_signer_and_inactive_policy() {
    let mut w = World::new(true);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .unwrap();
    let (root, ..) = two_buyer_list();

    let stranger = w.h.funded(LAMPORTS);
    w.h.send(
        &[w.set_buyer_root_ix(stranger.pubkey(), POLICY_ID, root)],
        &[&stranger],
    )
    .expect_err("yabancı imzacı")
    .assert_error(anchor_error(PolicyError::Unauthorized));
    assert!(merkle::is_unrestricted(
        &w.policy_account(&POLICY_ID).buyer_root
    ));

    w.send_owner(w.deactivate_ix(owner, POLICY_ID)).unwrap();
    w.send_owner(w.set_buyer_root_ix(owner, POLICY_ID, root))
        .expect_err("kapalı politika")
        .assert_error(anchor_error(PolicyError::PolicyInactive));
}

#[test]
fn after_binding_only_the_vault_sets_buyer_root() {
    let mut w = World::new(false);
    w.init_institution("Inst").unwrap();
    let owner = w.owner.pubkey();
    w.send_owner(w.set_policy_ix(owner, POLICY_ID, COMMITMENT, CEILING))
        .unwrap();
    let multisig = SquadsMultisig::create(&mut w.h);
    w.send_owner(w.set_multisig_ix(owner, multisig.address, multisig.address, 0))
        .unwrap();
    let vault = multisig.vault(0);
    let (root, ..) = two_buyer_list();

    w.send_owner(w.set_buyer_root_ix(owner, POLICY_ID, root))
        .expect_err("multisig sonrası sahip")
        .assert_error(anchor_error(PolicyError::Unauthorized));
    w.send_vault(w.set_buyer_root_ix(vault, POLICY_ID, root), vault)
        .unwrap();
    assert_eq!(w.policy_account(&POLICY_ID).buyer_root, root);
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
