//! square_policy (sözleşme arayüzü, BC-17): kurum ve politika commitment'ı; Squads multisig bağlanınca
//! yetkili yalnızca vault PDA'sı olur.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::seeds::{INSTITUTION_SEED, POLICY_SEED};
use square_policy::errors::PolicyError;
use square_policy::state::{Institution, Policy};
use square_program_tests::squads::{self, SquadsMultisig};
use square_program_tests::{anchor_error, cu, Harness};

const POLICY_ID: [u8; 32] = [7; 32];
const COMMITMENT: [u8; 32] = [2; 32];
const CEILING: u64 = 1_000_000_000; // 1 000 USDC

fn institution(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[INSTITUTION_SEED, owner.as_ref()], &square_policy::ID).0
}

fn policy(institution: &Pubkey, policy_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[POLICY_SEED, institution.as_ref(), policy_id],
        &square_policy::ID,
    )
    .0
}

fn init_institution(payer: &Pubkey, owner: &Keypair) -> Instruction {
    Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::InitInstitution {
            payer: *payer,
            authority: owner.pubkey(),
            institution: institution(&owner.pubkey()),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_policy::instruction::InitInstitution {
            name: "Acme Treasury".to_string(),
        }
        .data(),
    }
}

fn set_policy(
    payer: &Pubkey,
    owner: &Pubkey,
    authority: &Pubkey,
    daily_ceiling: u64,
) -> Instruction {
    let institution = institution(owner);
    Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::SetPolicy {
            payer: *payer,
            authority: *authority,
            institution,
            policy: policy(&institution, &POLICY_ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_policy::instruction::SetPolicy {
            policy_id: POLICY_ID,
            commitment: COMMITMENT,
            daily_ceiling,
        }
        .data(),
    }
}

fn set_multisig(owner: &Pubkey, authority: &Pubkey, multisig: Pubkey) -> Instruction {
    Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::SetInstitutionMultisig {
            authority: *authority,
            institution: institution(owner),
            squads_multisig: multisig,
        }
        .to_account_metas(None),
        data: square_policy::instruction::SetInstitutionMultisig {
            multisig,
            vault_index: 0,
        }
        .data(),
    }
}

#[test]
fn commits_a_policy_with_only_the_commitment_and_the_public_ceiling() {
    let mut h = Harness::new();
    h.deploy("square_policy", square_policy::ID);
    let owner = h.funded(1_000_000_000);
    let payer = h.payer.pubkey();
    h.send(&[init_institution(&payer, &owner)], &[&owner])
        .expect("init_institution");

    let executed = h
        .send(
            &[set_policy(
                &payer,
                &owner.pubkey(),
                &owner.pubkey(),
                CEILING,
            )],
            &[&owner],
        )
        .expect("set_policy");
    cu::within("policy.set_policy", &executed, 40_000);

    let address = institution(&owner.pubkey());
    let stored: Policy = h.account(&policy(&address, &POLICY_ID)).expect("Policy");
    assert_eq!(stored.institution, address);
    assert_eq!(stored.commitment, COMMITMENT);
    assert_eq!(stored.daily_ceiling, CEILING);
    assert_eq!(stored.buyer_root, [0; 32]);
    assert_eq!(stored.version, 1);
    assert!(stored.active);
    let inst: Institution = h.account(&address).expect("Institution");
    assert_eq!(inst.policy_count, 1);
    assert_eq!(inst.authority(), owner.pubkey());
}

#[test]
fn rejects_a_zero_ceiling_and_a_stranger() {
    let mut h = Harness::new();
    h.deploy("square_policy", square_policy::ID);
    let owner = h.funded(1_000_000_000);
    let stranger = h.funded(1_000_000_000);
    let payer = h.payer.pubkey();
    h.send(&[init_institution(&payer, &owner)], &[&owner])
        .expect("init_institution");

    h.send(
        &[set_policy(&payer, &owner.pubkey(), &owner.pubkey(), 0)],
        &[&owner],
    )
    .expect_err("tavan 0")
    .assert_error(anchor_error(PolicyError::InvalidDailyCeiling));
    h.send(
        &[set_policy(
            &payer,
            &owner.pubkey(),
            &stranger.pubkey(),
            CEILING,
        )],
        &[&stranger],
    )
    .expect_err("yabancı imzacı")
    .assert_error(anchor_error(PolicyError::Unauthorized));
}

/// Squads vault'u imzacı olarak: multisig bağlanınca kurumun sahibi artık yetkili değildir, politikayı
/// yalnızca vault PDA'sı yazar.
#[test]
fn a_bound_squads_vault_becomes_the_only_authority() {
    let mut h = Harness::without_sigverify();
    h.deploy("square_policy", square_policy::ID);
    let owner = h.funded(1_000_000_000);
    let payer = h.payer.pubkey();
    h.send(&[init_institution(&payer, &owner)], &[&owner])
        .expect("init_institution");

    let multisig = SquadsMultisig::create(&mut h);
    let vault = multisig.vault(0);
    h.send(
        &[set_multisig(
            &owner.pubkey(),
            &owner.pubkey(),
            multisig.address,
        )],
        &[&owner],
    )
    .expect("set_institution_multisig");
    let inst: Institution = h
        .account(&institution(&owner.pubkey()))
        .expect("Institution");
    assert_eq!(inst.multisig, Some(multisig.address));
    assert_eq!(inst.multisig_vault, Some(vault));
    assert_eq!(inst.authority(), vault);

    h.send(
        &[set_policy(
            &payer,
            &owner.pubkey(),
            &owner.pubkey(),
            CEILING,
        )],
        &[&owner],
    )
    .expect_err("multisig sonrası sahip")
    .assert_error(anchor_error(PolicyError::Unauthorized));
    let ix = set_policy(&payer, &owner.pubkey(), &vault, CEILING);
    h.send_as(&[ix], &[], &[vault])
        .expect("vault imzasıyla set_policy");
    let stored: Policy = h
        .account(&policy(&institution(&owner.pubkey()), &POLICY_ID))
        .expect("Policy");
    assert_eq!(stored.daily_ceiling, CEILING);
}

#[test]
fn only_an_initialized_squads_multisig_can_be_bound() {
    let mut h = Harness::new();
    h.deploy("square_policy", square_policy::ID);
    let owner = h.funded(1_000_000_000);
    let payer = h.payer.pubkey();
    h.send(&[init_institution(&payer, &owner)], &[&owner])
        .expect("init_institution");

    // Squads'a ait ama Multisig olmayan hesap ve Multisig discriminator'ı taşıyan ama başka programa ait hesap.
    let not_multisig =
        squads::write_account(&mut h, vec![1; 40], square_common::squads::PROGRAM_ID);
    let mut data = square_common::squads::MULTISIG_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&[0; 32]);
    let foreign = squads::write_account(&mut h, data, Pubkey::new_unique());
    for multisig in [not_multisig, foreign] {
        h.send(
            &[set_multisig(&owner.pubkey(), &owner.pubkey(), multisig)],
            &[&owner],
        )
        .expect_err("geçersiz multisig")
        .assert_error(anchor_error(PolicyError::InvalidSquadsMultisig));
    }
}
