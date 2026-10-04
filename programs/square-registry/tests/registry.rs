//! square_registry (henüz AIP registry'nin arayüzü; BC-15 did:aip v2 kaydına taşır): kayıt, sahiplik
//! kısıtı ve uzunluk sınırları.

use aip_registry::{AgentRecord, AgentType, Capability, RegistryError};
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use square_common::seeds::AGENT_SEED;
use square_testkit::TestKeypair as Keypair;
use square_testkit::TestSigner as Signer;
use square_testkit::{anchor_error, cu, Harness};

fn harness() -> Harness {
    let mut h = Harness::new();
    h.deploy("aip_registry", aip_registry::ID);
    h
}

fn agent_record(owner: &Pubkey, agent_id: &str) -> Pubkey {
    Pubkey::find_program_address(
        &[AGENT_SEED, owner.as_ref(), agent_id.as_bytes()],
        &aip_registry::ID,
    )
    .0
}

fn register(owner: &Keypair, agent_id: &str) -> Instruction {
    Instruction {
        program_id: aip_registry::ID,
        accounts: aip_registry::accounts::RegisterAgent {
            owner: owner.pubkey(),
            agent_record: agent_record(&owner.pubkey(), agent_id),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: aip_registry::instruction::RegisterAgent {
            agent_id: agent_id.to_string(),
            did: String::new(),
            name: "research agent".to_string(),
            endpoint: "https://agent.example/a2a".to_string(),
            wallet_address: owner.pubkey(),
            agent_type: AgentType::Task,
            capabilities: vec![Capability {
                name: "research".to_string(),
                description: "web research".to_string(),
            }],
            price_per_task: 1_000,
            version: "1.0.0".to_string(),
        }
        .data(),
    }
}

#[test]
fn registers_an_agent_under_its_owner() {
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    h.set_time(1_790_000_000);

    let executed = h
        .send(&[register(&owner, "alpha")], &[&owner])
        .expect("register_agent");
    cu::within("registry.register_agent", &executed, 60_000);

    let record: AgentRecord = h
        .account(&agent_record(&owner.pubkey(), "alpha"))
        .expect("AgentRecord");
    assert_eq!(record.owner, owner.pubkey());
    assert_eq!(record.agent_id, "alpha");
    assert_eq!(record.agent_type, AgentType::Task);
    assert_eq!(record.registered_at, 1_790_000_000);
}

#[test]
fn rejects_a_second_registration_of_the_same_id() {
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    h.send(&[register(&owner, "alpha")], &[&owner])
        .expect("ilk kayıt");
    // Aynı PDA'ya ikinci `init`: System programı hesabın zaten var olduğunu söyler.
    let failed = h
        .send(&[register(&owner, "alpha")], &[&owner])
        .expect_err("çift kayıt");
    assert!(
        failed.logs.iter().any(|l| l.contains("already in use")),
        "{}",
        failed.logs.join("\n")
    );
}

#[test]
fn an_agent_id_longer_than_a_seed_aborts_before_the_length_check() {
    // agent_id PDA seed'idir; 32 baytı aşan seed'le PDA türetilemez. Anchor'ın `seeds` kısıtı handler'daki
    // `AgentIdInvalid` kontrolünden önce çalıştığı için program o hatayı döndürmeden durur. Bugünkü
    // davranış budur; BC-15'in kaydı bu sınırı açık bir hatayla vermeli.
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    let mut ix = register(&owner, &"a".repeat(32));
    ix.data = aip_registry::instruction::RegisterAgent {
        agent_id: "a".repeat(33),
        did: String::new(),
        name: String::new(),
        endpoint: String::new(),
        wallet_address: owner.pubkey(),
        agent_type: AgentType::Llm,
        capabilities: vec![],
        price_per_task: 0,
        version: String::new(),
    }
    .data();
    let failed = h.send(&[ix], &[&owner]).expect_err("33 baytlık agent_id");
    assert_eq!(
        failed.error,
        square_testkit::TxError::InstructionError(
            0,
            square_testkit::InstructionErrorKind::ProgramFailedToComplete
        )
    );
}

#[test]
fn rejects_a_name_longer_than_64_bytes() {
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    let mut ix = register(&owner, "alpha");
    ix.data = aip_registry::instruction::RegisterAgent {
        agent_id: "alpha".to_string(),
        did: String::new(),
        name: "n".repeat(65),
        endpoint: String::new(),
        wallet_address: owner.pubkey(),
        agent_type: AgentType::Llm,
        capabilities: vec![],
        price_per_task: 0,
        version: String::new(),
    }
    .data();
    h.send(&[ix], &[&owner])
        .expect_err("uzun ad")
        .assert_error(anchor_error(RegistryError::NameTooLong));
}

#[test]
fn only_the_owner_can_update() {
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    let intruder = h.funded(1_000_000_000);
    h.send(&[register(&owner, "alpha")], &[&owner])
        .expect("register_agent");

    let update = Instruction {
        program_id: aip_registry::ID,
        accounts: aip_registry::accounts::UpdateAgent {
            owner: intruder.pubkey(),
            agent_record: agent_record(&owner.pubkey(), "alpha"),
        }
        .to_account_metas(None),
        data: aip_registry::instruction::UpdateAgent {
            name: "taken over".to_string(),
            endpoint: String::new(),
            wallet_address: intruder.pubkey(),
            agent_type: AgentType::Llm,
            capabilities: vec![],
            price_per_task: 0,
            version: String::new(),
        }
        .data(),
    };
    h.send(&[update], &[&intruder])
        .expect_err("yetkisiz update")
        .assert_error(anchor_error(RegistryError::Unauthorized));
}
