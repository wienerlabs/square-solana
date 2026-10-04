//! square_policy (henüz Aperture policy-registry'nin arayüzü; BC-17 sözleşmeye taşır): operatör ve
//! politika kaydı, Squads vault imzacısıyla kayıt.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use policy_registry::errors::PolicyRegistryError;
use policy_registry::instructions::SQUADS_V4_PROGRAM_ID;
use policy_registry::state::{OperatorAccount, PolicyAccount};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::seeds::{legacy::OPERATOR_SEED, POLICY_SEED};
use square_program_tests::squads::SquadsMultisig;
use square_program_tests::{anchor_error, cu, Harness};

const POLICY_ID: [u8; 32] = [7; 32];

fn operator(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[OPERATOR_SEED, authority.as_ref()], &policy_registry::ID).0
}

fn policy(operator: &Pubkey, policy_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[POLICY_SEED, operator.as_ref(), policy_id],
        &policy_registry::ID,
    )
    .0
}

fn initialize_operator(authority: &Keypair) -> Instruction {
    Instruction {
        program_id: policy_registry::ID,
        accounts: policy_registry::accounts::InitializeOperator {
            operator_account: operator(&authority.pubkey()),
            authority: authority.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: policy_registry::instruction::InitializeOperator {
            operator_name: "Acme Treasury".to_string(),
        }
        .data(),
    }
}

#[test]
fn registers_an_operator_and_a_policy() {
    let mut h = Harness::new();
    h.deploy("policy_registry", policy_registry::ID);
    let authority = h.funded(1_000_000_000);
    h.send(&[initialize_operator(&authority)], &[&authority])
        .expect("initialize_operator");

    let operator_address = operator(&authority.pubkey());
    let register = Instruction {
        program_id: policy_registry::ID,
        accounts: policy_registry::accounts::RegisterPolicy {
            policy_account: policy(&operator_address, &POLICY_ID),
            operator_account: operator_address,
            authority: authority.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: policy_registry::instruction::RegisterPolicy {
            policy_id: POLICY_ID,
            merkle_root: [1; 32],
            policy_data_hash: [2; 32],
        }
        .data(),
    };
    let executed = h.send(&[register], &[&authority]).expect("register_policy");
    cu::within("policy.register_policy", &executed, 40_000);

    let stored: PolicyAccount = h
        .account(&policy(&operator_address, &POLICY_ID))
        .expect("PolicyAccount");
    assert_eq!(stored.operator, operator_address);
    assert_eq!(stored.policy_data_hash, [2; 32]);
    assert!(stored.active);
    let op: OperatorAccount = h.account(&operator_address).expect("OperatorAccount");
    assert_eq!(op.policy_count, 1);
}

/// Squads vault'u imzacı olarak: operatör multisig'e bağlanır, politikayı vault PDA'sı kaydeder.
#[test]
fn a_squads_vault_registers_a_policy_and_a_stranger_cannot() {
    let mut h = Harness::without_sigverify();
    h.deploy("policy_registry", policy_registry::ID);
    let authority = h.funded(1_000_000_000);
    h.send(&[initialize_operator(&authority)], &[&authority])
        .expect("initialize_operator");

    let multisig = SquadsMultisig::create(&mut h, SQUADS_V4_PROGRAM_ID);
    let vault = multisig.vault(0);
    let operator_address = operator(&authority.pubkey());
    let set_multisig = Instruction {
        program_id: policy_registry::ID,
        accounts: policy_registry::accounts::SetMultisig {
            operator_account: operator_address,
            authority: authority.pubkey(),
            squads_multisig: multisig.address,
        }
        .to_account_metas(None),
        data: policy_registry::instruction::SetMultisig { vault_index: 0 }.data(),
    };
    h.send(&[set_multisig], &[&authority])
        .expect("set_multisig");
    let op: OperatorAccount = h.account(&operator_address).expect("OperatorAccount");
    assert_eq!(op.multisig, Some(vault));

    let payer = h.payer.pubkey();
    let register_as = |signer: Pubkey| Instruction {
        program_id: policy_registry::ID,
        accounts: policy_registry::accounts::RegisterPolicyMultisig {
            policy_account: policy(&operator_address, &POLICY_ID),
            operator_account: operator_address,
            squads_multisig: multisig.address,
            multisig_signer: signer,
            payer,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: policy_registry::instruction::RegisterPolicyMultisig {
            policy_id: POLICY_ID,
            merkle_root: [1; 32],
            policy_data_hash: [2; 32],
            vault_index: 0,
        }
        .data(),
    };

    let stranger = Keypair::new();
    let ix = register_as(stranger.pubkey());
    h.send_as(&[ix], &[&stranger], &[])
        .expect_err("vault olmayan imzacı")
        .assert_error(anchor_error(PolicyRegistryError::UnauthorizedMultisig));

    let ix = register_as(vault);
    h.send_as(&[ix], &[], &[vault])
        .expect("vault imzasıyla register_policy_multisig");
    let stored: PolicyAccount = h
        .account(&policy(&operator_address, &POLICY_ID))
        .expect("PolicyAccount");
    assert_eq!(stored.operator, operator_address);
}
