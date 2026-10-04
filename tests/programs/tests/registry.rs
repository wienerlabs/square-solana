//! square_registry (sözleşme arayüzü, BC-15; did:aip v2 Solana profili §4): kayıt, kart işaretçisi ve
//! hash'i, durum, sahiplik devri ve kalıcı kayıt silme; her değişiklik event'iyle.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::seeds::AGENT_SEED;
use square_program_tests::squads::SquadsMultisig;
use square_program_tests::{anchor_error, cu, event, Executed, Harness};
use square_registry::errors::RegistryError;
use square_registry::state::AgentRecord;
use square_registry::{
    AgentDeregistered, AgentOwnershipTransferred, AgentRegistered, AgentStatus, AgentStatusChanged,
    AgentUpdated,
};

const NOW: i64 = 1_790_000_000;
const CARD_URI: &str = "https://agents.example/alpha/agent-card.json";
const CARD_HASH: [u8; 32] = [0xab; 32];

fn harness() -> Harness {
    let mut h = Harness::new();
    h.deploy("square_registry", square_registry::ID);
    h.set_time(NOW);
    h
}

fn record_address(creator: &Pubkey, agent_id: &str) -> Pubkey {
    Pubkey::find_program_address(
        &[AGENT_SEED, creator.as_ref(), agent_id.as_bytes()],
        &square_registry::ID,
    )
    .0
}

/// `agent_record` adresi verilen kimlikten türetilir; 32 baytı aşan kimlik için 32 baytlık önekten
/// (program kimliği seed'den önce reddetmeli).
fn register_ix(
    payer: &Pubkey,
    owner: &Pubkey,
    agent_id: &str,
    uri: &str,
    hash: [u8; 32],
    wallet: Pubkey,
) -> Instruction {
    let seed = &agent_id.as_bytes()[..agent_id.len().min(32)];
    let agent_record =
        Pubkey::find_program_address(&[AGENT_SEED, owner.as_ref(), seed], &square_registry::ID).0;
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::RegisterAgent {
            payer: *payer,
            owner: *owner,
            agent_record,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_registry::instruction::RegisterAgent {
            agent_id: agent_id.to_string(),
            agent_card_uri: uri.to_string(),
            agent_card_hash: hash,
            wallet,
        }
        .data(),
    }
}

fn update_ix(
    owner: &Pubkey,
    record: Pubkey,
    uri: &str,
    hash: [u8; 32],
    wallet: Pubkey,
) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::UpdateAgent {
            owner: *owner,
            agent_record: record,
        }
        .to_account_metas(None),
        data: square_registry::instruction::UpdateAgent {
            agent_card_uri: uri.to_string(),
            agent_card_hash: hash,
            wallet,
        }
        .data(),
    }
}

fn status_ix(owner: &Pubkey, record: Pubkey, status: AgentStatus) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::SetAgentStatus {
            owner: *owner,
            agent_record: record,
        }
        .to_account_metas(None),
        data: square_registry::instruction::SetAgentStatus { status }.data(),
    }
}

fn transfer_ix(owner: &Pubkey, record: Pubkey, new_owner: Pubkey) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::TransferAgentOwnership {
            owner: *owner,
            agent_record: record,
        }
        .to_account_metas(None),
        data: square_registry::instruction::TransferAgentOwnership { new_owner }.data(),
    }
}

fn deregister_ix(owner: &Pubkey, record: Pubkey) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::DeregisterAgent {
            owner: *owner,
            agent_record: record,
        }
        .to_account_metas(None),
        data: square_registry::instruction::DeregisterAgent {}.data(),
    }
}

/// Kayıtlı bir agent: sahibi (`creator`), cüzdanı ve kaydın adresi.
struct Agent {
    owner: Keypair,
    wallet: Pubkey,
    record: Pubkey,
}

fn registered(h: &mut Harness, agent_id: &str) -> (Agent, Executed) {
    let owner = h.funded(1_000_000_000);
    let wallet = Pubkey::new_unique();
    let ix = register_ix(
        &h.payer.pubkey(),
        &owner.pubkey(),
        agent_id,
        CARD_URI,
        CARD_HASH,
        wallet,
    );
    let executed = h.send(&[ix], &[&owner]).expect("register_agent");
    let record = record_address(&owner.pubkey(), agent_id);
    (
        Agent {
            owner,
            wallet,
            record,
        },
        executed,
    )
}

#[test]
fn registers_an_agent_card_without_a_did_string() {
    let mut h = harness();
    let (agent, executed) = registered(&mut h, "alpha-1");
    cu::within("registry.register_agent", &executed, 40_000);

    let record: AgentRecord = h.account(&agent.record).expect("AgentRecord");
    assert_eq!(record.creator, agent.owner.pubkey());
    assert_eq!(record.owner, agent.owner.pubkey());
    assert_eq!(record.wallet, agent.wallet);
    assert_eq!(record.agent_id, "alpha-1");
    assert_eq!(record.agent_card_uri, CARD_URI);
    assert_eq!(record.agent_card_hash, CARD_HASH);
    assert_eq!(record.status, AgentStatus::Active);
    assert_eq!((record.registered_at, record.updated_at), (NOW, NOW));
    // Zincirde DID metni yok: hesap yalnızca sözleşmedeki alanları taşır (profil §4.2/1).
    let raw = h.raw_account(&agent.record).unwrap();
    assert_eq!(raw.data.len(), AgentRecord::SPACE);
    assert!(!raw.data.windows(7).any(|w| w == b"did:aip"));

    let registered: AgentRegistered = event(&executed);
    assert_eq!(registered.agent_record, agent.record);
    assert_eq!(registered.creator, agent.owner.pubkey());
    assert_eq!(registered.owner, agent.owner.pubkey());
    assert_eq!(registered.agent_id, "alpha-1");
    assert_eq!(registered.wallet, agent.wallet);
    assert_eq!(registered.agent_card_hash, CARD_HASH);
}

#[test]
fn a_card_can_be_omitted_with_a_zero_hash() {
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    let ix = register_ix(
        &h.payer.pubkey(),
        &owner.pubkey(),
        "beta",
        "",
        [0; 32],
        owner.pubkey(),
    );
    h.send(&[ix], &[&owner]).expect("kartsız kayıt");
    let record: AgentRecord = h.account(&record_address(&owner.pubkey(), "beta")).unwrap();
    assert_eq!(
        (record.agent_card_uri.as_str(), record.agent_card_hash),
        ("", [0; 32])
    );
}

#[test]
fn rejects_agent_ids_outside_the_slug_alphabet_and_length() {
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    let payer = h.payer.pubkey();
    for agent_id in ["", "has space", "slash/id", "dot.id", "ünicode"] {
        let ix = register_ix(
            &payer,
            &owner.pubkey(),
            agent_id,
            CARD_URI,
            CARD_HASH,
            owner.pubkey(),
        );
        h.send(&[ix], &[&owner])
            .expect_err(agent_id)
            .assert_error(anchor_error(RegistryError::AgentIdInvalid));
    }
    // 32 baytı aşan kimlikle PDA türetilemez; Anchor `init` seed'lerini kimlik kısıtından önce türettiği
    // için işlem `AgentIdInvalid` yerine orada durur. Kayıt yine de oluşmaz.
    let long = "a".repeat(33);
    let ix = register_ix(
        &payer,
        &owner.pubkey(),
        &long,
        CARD_URI,
        CARD_HASH,
        owner.pubkey(),
    );
    let failed = h.send(&[ix], &[&owner]).expect_err("33 baytlık kimlik");
    assert_eq!(
        failed.error,
        solana_transaction_error::TransactionError::InstructionError(
            0,
            solana_instruction_error::InstructionError::ProgramFailedToComplete
        )
    );
    assert!(h
        .raw_account(&record_address(&owner.pubkey(), &long[..32]))
        .is_none());
    // Alfabenin kenarları ve 32 karakter geçer.
    for agent_id in ["A-Z_0-9", &"z".repeat(32)] {
        let ix = register_ix(
            &payer,
            &owner.pubkey(),
            agent_id,
            CARD_URI,
            CARD_HASH,
            owner.pubkey(),
        );
        h.send(&[ix], &[&owner]).expect(agent_id);
    }
}

#[test]
fn the_card_uri_and_hash_move_together() {
    let mut h = harness();
    let owner = h.funded(1_000_000_000);
    let payer = h.payer.pubkey();
    let cases: [(&str, [u8; 32], u32); 3] = [
        (
            "",
            CARD_HASH,
            anchor_error(RegistryError::AgentCardHashInvalid),
        ),
        (
            CARD_URI,
            [0; 32],
            anchor_error(RegistryError::AgentCardHashInvalid),
        ),
        (
            &"u".repeat(201),
            CARD_HASH,
            anchor_error(RegistryError::AgentCardUriTooLong),
        ),
    ];
    for (uri, hash, code) in cases {
        let ix = register_ix(&payer, &owner.pubkey(), "gamma", uri, hash, owner.pubkey());
        h.send(&[ix], &[&owner]).expect_err(uri).assert_error(code);
    }
    let ix = register_ix(
        &payer,
        &owner.pubkey(),
        "gamma",
        &"u".repeat(200),
        CARD_HASH,
        owner.pubkey(),
    );
    h.send(&[ix], &[&owner]).expect("200 baytlık URI");
}

#[test]
fn the_same_creator_and_id_register_once() {
    let mut h = harness();
    let (agent, _) = registered(&mut h, "alpha");
    let ix = register_ix(
        &h.payer.pubkey(),
        &agent.owner.pubkey(),
        "alpha",
        CARD_URI,
        CARD_HASH,
        agent.wallet,
    );
    let failed = h.send(&[ix], &[&agent.owner]).expect_err("çift kayıt");
    assert!(
        failed.logs.iter().any(|l| l.contains("already in use")),
        "{}",
        failed.logs.join("\n")
    );
    // Aynı kimlik başka bir creator altında ayrı bir kayıttır.
    let (other, _) = registered(&mut h, "alpha");
    assert_ne!(other.record, agent.record);
}

#[test]
fn the_owner_updates_the_card_and_wallet() {
    let mut h = harness();
    let (agent, _) = registered(&mut h, "alpha");
    h.advance(60);
    let wallet = Pubkey::new_unique();
    let executed = h
        .send(
            &[update_ix(
                &agent.owner.pubkey(),
                agent.record,
                "ipfs://bafy-card-v2",
                [0xcd; 32],
                wallet,
            )],
            &[&agent.owner],
        )
        .expect("update_agent");
    let record: AgentRecord = h.account(&agent.record).unwrap();
    assert_eq!(record.agent_card_uri, "ipfs://bafy-card-v2");
    assert_eq!(record.agent_card_hash, [0xcd; 32]);
    assert_eq!(record.wallet, wallet);
    assert_eq!((record.registered_at, record.updated_at), (NOW, NOW + 60));
    let updated: AgentUpdated = event(&executed);
    assert_eq!(
        (
            updated.agent_record,
            updated.wallet,
            updated.agent_card_hash
        ),
        (agent.record, wallet, [0xcd; 32])
    );

    // Kart kuralları update'te de geçerli.
    h.send(
        &[update_ix(
            &agent.owner.pubkey(),
            agent.record,
            "",
            [0xcd; 32],
            wallet,
        )],
        &[&agent.owner],
    )
    .expect_err("boş URI, dolu hash")
    .assert_error(anchor_error(RegistryError::AgentCardHashInvalid));
}

#[test]
fn only_the_owner_mutates_the_record() {
    let mut h = harness();
    let (agent, _) = registered(&mut h, "alpha");
    let stranger = h.funded(1_000_000_000);
    let s = stranger.pubkey();
    let attempts = [
        update_ix(&s, agent.record, CARD_URI, CARD_HASH, s),
        status_ix(&s, agent.record, AgentStatus::Inactive),
        transfer_ix(&s, agent.record, s),
        deregister_ix(&s, agent.record),
    ];
    for ix in attempts {
        h.send(&[ix], &[&stranger])
            .expect_err("yabancı imzacı")
            .assert_error(anchor_error(RegistryError::Unauthorized));
    }
}

#[test]
fn pauses_and_resumes_but_never_sets_deregistered_directly() {
    let mut h = harness();
    let (agent, _) = registered(&mut h, "alpha");
    let o = agent.owner.pubkey();
    let executed = h
        .send(
            &[status_ix(&o, agent.record, AgentStatus::Inactive)],
            &[&agent.owner],
        )
        .expect("Inactive");
    let changed: AgentStatusChanged = event(&executed);
    assert_eq!(
        (changed.agent_record, changed.status),
        (agent.record, AgentStatus::Inactive)
    );
    assert_eq!(
        h.account::<AgentRecord>(&agent.record).unwrap().status,
        AgentStatus::Inactive
    );
    // Duraklatılmış agent'ın kartı güncellenebilir.
    h.send(
        &[update_ix(
            &o,
            agent.record,
            CARD_URI,
            CARD_HASH,
            agent.wallet,
        )],
        &[&agent.owner],
    )
    .expect("Inactive iken update");
    h.send(
        &[status_ix(&o, agent.record, AgentStatus::Active)],
        &[&agent.owner],
    )
    .expect("Active");
    h.send(
        &[status_ix(&o, agent.record, AgentStatus::Deregistered)],
        &[&agent.owner],
    )
    .expect_err("set_agent_status(Deregistered)")
    .assert_error(anchor_error(RegistryError::InvalidAgentStatus));
}

#[test]
fn a_transfer_keeps_the_address_and_resets_the_wallet() {
    let mut h = harness();
    let (agent, _) = registered(&mut h, "alpha");
    let new_owner = h.funded(1_000_000_000);
    h.advance(10);
    let executed = h
        .send(
            &[transfer_ix(
                &agent.owner.pubkey(),
                agent.record,
                new_owner.pubkey(),
            )],
            &[&agent.owner],
        )
        .expect("transfer_agent_ownership");
    let record: AgentRecord = h.account(&agent.record).unwrap();
    assert_eq!(record.creator, agent.owner.pubkey());
    assert_eq!(record.owner, new_owner.pubkey());
    assert_eq!(record.wallet, new_owner.pubkey());
    assert_eq!(record.updated_at, NOW + 10);
    let transferred: AgentOwnershipTransferred = event(&executed);
    assert_eq!(
        (
            transferred.agent_record,
            transferred.previous_owner,
            transferred.new_owner
        ),
        (agent.record, agent.owner.pubkey(), new_owner.pubkey())
    );

    // Eski sahip artık yetkili değil; yeni sahip aynı adresteki kaydı yönetir.
    h.send(
        &[update_ix(
            &agent.owner.pubkey(),
            agent.record,
            CARD_URI,
            CARD_HASH,
            agent.wallet,
        )],
        &[&agent.owner],
    )
    .expect_err("eski sahip")
    .assert_error(anchor_error(RegistryError::Unauthorized));
    h.send(
        &[update_ix(
            &new_owner.pubkey(),
            agent.record,
            CARD_URI,
            CARD_HASH,
            Pubkey::new_unique(),
        )],
        &[&new_owner],
    )
    .expect("yeni sahip");
}

#[test]
fn deregistration_is_permanent_and_the_address_is_never_reused() {
    let mut h = harness();
    let (agent, _) = registered(&mut h, "alpha");
    let o = agent.owner.pubkey();
    let executed = h
        .send(&[deregister_ix(&o, agent.record)], &[&agent.owner])
        .expect("deregister_agent");
    let deregistered: AgentDeregistered = event(&executed);
    assert_eq!(deregistered.agent_record, agent.record);
    let record: AgentRecord = h.account(&agent.record).expect("kayıt kapatılmaz");
    assert_eq!(record.status, AgentStatus::Deregistered);

    let after = [
        update_ix(&o, agent.record, CARD_URI, CARD_HASH, agent.wallet),
        status_ix(&o, agent.record, AgentStatus::Active),
        transfer_ix(&o, agent.record, Pubkey::new_unique()),
        deregister_ix(&o, agent.record),
    ];
    for ix in after {
        h.send(&[ix], &[&agent.owner])
            .expect_err("kayıt silindikten sonra")
            .assert_error(anchor_error(RegistryError::AgentDeregistered));
    }
    let ix = register_ix(
        &h.payer.pubkey(),
        &o,
        "alpha",
        CARD_URI,
        CARD_HASH,
        agent.wallet,
    );
    h.send(&[ix], &[&agent.owner])
        .expect_err("aynı kimlikle yeniden kayıt");
}

/// Sahip bir PDA olabilir (profil §4.2/6): Squads vault'u kaydeder ve yönetir.
#[test]
fn a_squads_vault_can_own_an_agent() {
    let mut h = Harness::without_sigverify();
    h.deploy("square_registry", square_registry::ID);
    h.set_time(NOW);
    let vault = SquadsMultisig::create(&mut h).vault(0);
    let ix = register_ix(
        &h.payer.pubkey(),
        &vault,
        "treasury-agent",
        CARD_URI,
        CARD_HASH,
        vault,
    );
    h.send_as(&[ix], &[], &[vault]).expect("vault kaydı");
    let record = record_address(&vault, "treasury-agent");
    assert_eq!(h.account::<AgentRecord>(&record).unwrap().owner, vault);
    let ix = status_ix(&vault, record, AgentStatus::Inactive);
    h.send_as(&[ix], &[], &[vault])
        .expect("vault imzasıyla set_agent_status");
}
