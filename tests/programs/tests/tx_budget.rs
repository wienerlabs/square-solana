//! İşlem bütçesi (BC-28): 8 adımın her tx'i SDK'nın kurduğu biçimde ve en kötü durumuyla kurulur:
//! compute budget talimatları (sınır profilden, öncelik ücreti), alıcı tarafın ATA'sını açan idempotent
//! talimatlar, en uzun alanlar, en derin alıcı listesi, gerçek Groth16 ispatı ve `record_release` CPI'ı.
//! Her tx için tel boyutu (lookup table'sız ve Square ALT'ıyla) ve compute unit ölçülür.
//!
//! Sınırlar ve ALT'ın içeriği SDK'nın profilindendir (`packages/sdk/src/tx-profile.json`): her tx paket
//! sınırına (1232 bayt) sığmalı ve ölçülen compute unit sınırın `1 - headroom`'unu aşmamalıdır. ALT
//! zincirde ALT programının talimatlarıyla kurulur ve tx'ler onunla gönderilir. Tablo
//! (docs/design/tx-budget.md): `cargo test --test tx_budget -- --nocapture`.

mod escrow_world;
mod release_world;

use std::collections::BTreeMap;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use escrow_world::*;
use release_world::*;
use serde_json::Value;
use solana_keypair::Keypair;
use solana_message::AddressLookupTableAccount;
use solana_signer::Signer;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use square_common::constants::MAX_BUYER_PROOF_DEPTH;
use square_program_tests::token::{self, TOKEN_PROGRAM_ID};
use square_program_tests::{
    compute_unit_limit, compute_unit_price, wire_size, Executed, Harness, PACKET_DATA_SIZE,
};
use square_registry::ScreeningStatus;

const PROFILE: &str = include_str!("../../../packages/sdk/src/tx-profile.json");
/// Ölçümdeki öncelik ücreti (micro-lamport / CU). Talimatın boyutu ve compute unit'i değerden bağımsızdır;
/// ana ağda gönderilecek tx'in biçimi ölçülsün diye eklenir.
const PRIORITY_FEE: u64 = 1_000;
const LAMPORTS: u64 = 1_000_000_000;

/// SDK'nın işlem profili.
struct Profile {
    headroom: f64,
    limits: BTreeMap<String, u32>,
    lookup_table: Vec<String>,
}

fn profile() -> Profile {
    let json: Value = serde_json::from_str(PROFILE).expect("tx-profile.json");
    let headroom = json["headroom"].as_f64().expect("headroom");
    assert!(
        (0.0..1.0).contains(&headroom),
        "headroom [0, 1) aralığında olmalı"
    );
    let limits = json["computeUnitLimits"]
        .as_object()
        .expect("computeUnitLimits")
        .iter()
        .map(|(kind, limit)| {
            let limit = limit.as_u64().expect("sınır tamsayı olmalı");
            (kind.clone(), u32::try_from(limit).expect("sınır u32"))
        })
        .collect();
    let lookup_table = json["lookupTable"]
        .as_array()
        .expect("lookupTable")
        .iter()
        .map(|entry| entry.as_str().expect("ALT girdisi").to_string())
        .collect();
    Profile {
        headroom,
        limits,
        lookup_table,
    }
}

/// Profilin sembolik ALT girdisinin bu dünyadaki adresi (SDK'daki çözümün karşılığı).
fn resolve(entry: &str, settlement_mint: Pubkey) -> Pubkey {
    match entry {
        "program:registry" => square_registry::ID,
        "program:policy" => square_policy::ID,
        "program:verifier" => square_verifier::ID,
        "program:escrow" => square_escrow::ID,
        "pda:registryConfig" => registry_config_address(),
        "pda:escrowConfig" => config_address(),
        "pda:verifierConfig" => verifier_config_address(),
        "pda:escrowAuthority" => escrow_authority_address(),
        "settlementMint" => settlement_mint,
        "program:system" => anchor_lang::system_program::ID,
        "program:token" => TOKEN_PROGRAM_ID,
        "program:token2022" => spl_token_2022_interface::ID,
        "sysvar:instructions" => solana_sdk_ids::sysvar::instructions::ID,
        other => panic!("profilde bilinmeyen ALT girdisi: {other}"),
    }
}

/// Bir tx'in ölçümü.
struct Row {
    kinds: String,
    case: &'static str,
    signatures: usize,
    accounts: usize,
    plain_size: usize,
    table_size: usize,
    compute_units: u64,
    limit: u32,
}

/// Bir dünyanın Square ALT'ı ve ölçümleri.
struct Meter<'p> {
    profile: &'p Profile,
    table: AddressLookupTableAccount,
    rows: Vec<Row>,
}

impl<'p> Meter<'p> {
    fn new(profile: &'p Profile, h: &mut Harness, settlement_mint: Pubkey) -> Self {
        let addresses: Vec<Pubkey> = profile
            .lookup_table
            .iter()
            .map(|entry| resolve(entry, settlement_mint))
            .collect();
        Self {
            profile,
            table: h.create_lookup_table(&addresses),
            rows: Vec::new(),
        }
    }

    /// Tx türlerinin sınırlarının toplamı (birden çok talimatı tek tx'te birleştiren istemci için).
    fn limit(&self, kinds: &[&str]) -> u32 {
        kinds
            .iter()
            .map(|kind| {
                *self
                    .profile
                    .limits
                    .get(*kind)
                    .unwrap_or_else(|| panic!("profilde {kind} yok"))
            })
            .sum()
    }

    /// Tx'i profilin sınırı ve öncelik ücretiyle kurar, ALT'lı ve ALT'sız boyutunu ölçer, ALT'la gönderir.
    fn run(
        &mut self,
        h: &mut Harness,
        kinds: &[&str],
        case: &'static str,
        instructions: Vec<Instruction>,
        signers: &[&Keypair],
    ) -> Executed {
        let limit = self.limit(kinds);
        let all: Vec<Instruction> = [compute_unit_limit(limit), compute_unit_price(PRIORITY_FEE)]
            .into_iter()
            .chain(instructions)
            .collect();
        let plain = h.v0_transaction(&all, signers, &[]);
        let tx = h.v0_transaction(&all, signers, std::slice::from_ref(&self.table));
        let row = Row {
            kinds: kinds.join(" + "),
            case,
            signatures: tx.signatures.len(),
            accounts: plain.message.static_account_keys().len(),
            plain_size: wire_size(&plain),
            table_size: wire_size(&tx),
            compute_units: 0,
            limit,
        };
        let executed = h.send_transaction(tx).unwrap_or_else(|failed| {
            panic!(
                "{}: {:?}\n{}",
                row.kinds,
                failed.error,
                failed.logs.join("\n")
            )
        });
        let row = Row {
            compute_units: executed.compute_units,
            ..row
        };
        // ALT'sız boyut tabloda raporlanır; Square ALT'ıyla her tx pakete sığmalıdır.
        assert!(
            row.table_size <= PACKET_DATA_SIZE,
            "{}: Square ALT'ıyla {} bayt, sınır {PACKET_DATA_SIZE}",
            row.kinds,
            row.table_size
        );
        let allowed = f64::from(limit) * (1.0 - self.profile.headroom);
        assert!(
            row.compute_units as f64 <= allowed,
            "{}: {} CU, sınır {limit} ve %{:.0} pay ile en çok {allowed:.0}",
            row.kinds,
            row.compute_units,
            self.profile.headroom * 100.0
        );
        self.rows.push(row);
        executed
    }
}

fn print_table(rows: &[Row]) {
    println!("| Tx | Durum | İmza | Hesap | Boyut, ALT'sız | Boyut, Square ALT | CU | Sınır |");
    println!("|---|---|---|---|---|---|---|---|");
    for row in rows {
        let plain = if row.plain_size > PACKET_DATA_SIZE {
            format!("**{}** (sığmaz)", row.plain_size)
        } else {
            row.plain_size.to_string()
        };
        println!(
            "| `{}` | {} | {} | {} | {} | {} | {} | {} |",
            row.kinds,
            row.case,
            row.signatures,
            row.accounts,
            plain,
            row.table_size,
            row.compute_units,
            row.limit
        );
    }
}

/// `payer`'ın ödediği, `owner`'ın ATA'sını (yoksa) açan talimat; SDK alıcı tarafların hesabını böyle açar.
fn open_ata(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey) -> Instruction {
    create_associated_token_account_idempotent(payer, owner, mint, &TOKEN_PROGRAM_ID)
}

/// ALT'sız gönderilen alım tx'inin pakete sığdığı en uzun kanıt (kardeş sayısı); tx gönderilmez.
fn deepest_proof_without_table(
    w: &mut World,
    buy: &[Instruction],
    limit: u32,
    signers: &[&Keypair],
    proof_index: usize,
) -> usize {
    (0..=MAX_BUYER_PROOF_DEPTH)
        .rev()
        .find(|depth| {
            let shortened: Vec<Instruction> = buy
                .iter()
                .enumerate()
                .map(|(i, ix)| {
                    if i == proof_index {
                        with_proof_depth(ix, *depth)
                    } else {
                        ix.clone()
                    }
                })
                .collect();
            let all: Vec<Instruction> =
                [compute_unit_limit(limit), compute_unit_price(PRIORITY_FEE)]
                    .into_iter()
                    .chain(shortened)
                    .collect();
            wire_size(&w.h.v0_transaction(&all, signers, &[])) <= PACKET_DATA_SIZE
        })
        .expect("kanıtsız alım da sığmıyor")
}

/// `buy_claim` talimatının verisi: kanıt `depth` kardeşe kısaltılmış (yalnızca boyut ölçümü için).
fn with_proof_depth(ix: &Instruction, depth: usize) -> Instruction {
    // Veri: 8 bayt ayırıcı, fiyat (8), salt (32), kanıt uzunluğu (u32) ve kardeşler.
    const PROOF_LEN_OFFSET: usize = 8 + 8 + 32;
    let siblings = &ix.data[PROOF_LEN_OFFSET + 4..];
    let data = [
        &ix.data[..PROOF_LEN_OFFSET],
        &(depth as u32).to_le_bytes(),
        &siblings[..depth * 32],
    ]
    .concat();
    Instruction { data, ..ix.clone() }
}

/// Adım 1–5 ve policy'siz release: kurum, agent, screening, iş, alacak, iptal ve cüzdan taşıma. İkinci
/// değer ALT'sız alımda pakete sığan en uzun kanıttır.
fn institution_agent_job_and_claim(profile: &Profile) -> (Vec<Row>, usize) {
    let mut w = World::new(true);
    let mut meter = Meter::new(profile, &mut w.h, w.usdc);
    let usdc = w.usdc;
    let payer = w.h.payer.pubkey();

    // Adım 1: kurum, politika, güncelleme; web üç talimatı tek tx'te de gönderir.
    let institution = w.institution(10 * AMOUNT);
    let key = institution.key.insecure_clone();
    let name = "n".repeat(square_policy::state::Institution::MAX_NAME_LEN);
    let policy = PolicyAccounts {
        institution: institution_address(&key.pubkey()),
        policy: policy_address(&institution_address(&key.pubkey()), &POLICY_ID),
    };
    let ix = w.init_institution_ix(&key.pubkey(), &name);
    meter.run(
        &mut w.h,
        &["initInstitution"],
        "64 baytlık ad",
        vec![ix],
        &[&key],
    );
    let ix = w.set_policy_ix(
        &key.pubkey(),
        policy.institution,
        POLICY_ID,
        COMMITMENT,
        CEILING,
    );
    meter.run(&mut w.h, &["setPolicy"], "", vec![ix], &[&key]);
    let ix = w.update_policy_ix(&key.pubkey(), policy, [0x2d; 32], CEILING / 2);
    meter.run(&mut w.h, &["updatePolicy"], "", vec![ix], &[&key]);
    let other = w.institution(0);
    let other_policy = PolicyAccounts {
        institution: institution_address(&other.key.pubkey()),
        policy: policy_address(&institution_address(&other.key.pubkey()), &POLICY_ID),
    };
    let combined = vec![
        w.init_institution_ix(&other.key.pubkey(), &name),
        w.set_policy_ix(
            &other.key.pubkey(),
            other_policy.institution,
            POLICY_ID,
            COMMITMENT,
            CEILING,
        ),
        w.set_buyer_root_ix(&other.key.pubkey(), other_policy, [0x3e; 32]),
    ];
    meter.run(
        &mut w.h,
        &["initInstitution", "setPolicy", "setBuyerRoot"],
        "web: tek tx",
        combined,
        &[&other.key],
    );

    // Adım 2: en uzun kimlik ve kart URI'siyle agent kaydı.
    let owner = w.h.funded(LAMPORTS);
    let wallet = Keypair::new();
    let agent_id = "a".repeat(square_registry::state::AgentRecord::MAX_AGENT_ID_LEN);
    let card_uri = "u".repeat(square_registry::state::AgentRecord::MAX_AGENT_CARD_URI_LEN);
    let ix = w.register_agent_ix(
        &owner.pubkey(),
        &agent_id,
        (&card_uri, [0xc4; 32]),
        &wallet.pubkey(),
    );
    meter.run(
        &mut w.h,
        &["registerAgent"],
        "32 baytlık kimlik, 200 baytlık kart URI'si",
        vec![ix],
        &[&owner],
    );
    let agent = Agent {
        record: agent_record_address(&owner.pubkey(), &agent_id),
        owner,
        wallet,
    };

    // Adım 3: screening, policy'li iş, fonlama.
    let screener = w.screener.insecure_clone();
    let ix = w.record_screening_ix(&agent.wallet.pubkey(), ScreeningStatus::Clear);
    meter.run(&mut w.h, &["recordScreening"], "", vec![ix], &[&screener]);
    w.screen(&key.pubkey(), ScreeningStatus::Clear);
    let ix = w.create_job_ix(
        &key.pubkey(),
        agent.record,
        Some(policy),
        SPEC,
        AMOUNT,
        w.h.now() + 7 * DAY,
        CHALLENGE,
        usdc,
    );
    meter.run(&mut w.h, &["createJob"], "policy'li", vec![ix], &[&key]);
    let job = job_address(&key.pubkey(), &SPEC);
    let ix = w.commit_travel_rule_ix(&key.pubkey(), &job, [0x7c; 32]);
    meter.run(&mut w.h, &["commitTravelRule"], "", vec![ix], &[&key]);
    let ix = w.fund_job_ix(&institution, &job);
    meter.run(&mut w.h, &["fundJob"], "", vec![ix], &[&key]);

    // Adım 4: kabul, en uzun URI'yle teslim.
    let ix = w.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
    meter.run(&mut w.h, &["acceptJob"], "", vec![ix], &[&agent.wallet]);
    let delivery_uri = "d".repeat(square_escrow::state::DELIVERY_URI_MAX_LEN);
    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, &delivery_uri);
    meter.run(
        &mut w.h,
        &["submitWork"],
        "128 baytlık URI",
        vec![ix],
        &[&agent.wallet],
    );

    // Adım 5: 16 kardeşli listeye karşı alım; satıcının ATA'sı bu tx'te açılır.
    let buyer = w.buyer(CLAIM_PRICE);
    let members = std::iter::once((buyer.key.pubkey(), [0x11; 32]))
        .chain((0..1u32 << 15).map(|_| (Pubkey::new_unique(), [0x22; 32])))
        .collect();
    let list = BuyerList::new(members);
    let ix = w.set_buyer_root_ix(&key.pubkey(), policy, list.root());
    meter.run(&mut w.h, &["setBuyerRoot"], "", vec![ix], &[&key]);
    let ix = w.list_claim_ix(&agent.wallet.pubkey(), &job, CLAIM_PRICE);
    meter.run(&mut w.h, &["listClaim"], "", vec![ix], &[&agent.wallet]);
    let ix = w.cancel_claim_ix(&agent.wallet.pubkey(), &job, payer);
    meter.run(&mut w.h, &["cancelClaim"], "", vec![ix], &[&agent.wallet]);
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("yeniden listeleme");
    let buy = vec![
        open_ata(&payer, &agent.wallet.pubkey(), &usdc),
        w.buy_claim_ix(&buyer, &job, CLAIM_PRICE, &list.eligibility(0)),
    ];
    let buyer_key = buyer.key.insecure_clone();
    let plain_depth =
        deepest_proof_without_table(&mut w, &buy, meter.limit(&["buyClaim"]), &[&buyer_key], 1);
    meter.run(
        &mut w.h,
        &["buyClaim"],
        "16 kardeşli kanıt, satıcının ATA'sı açılır",
        buy,
        &[&buyer.key],
    );

    // Cüzdan taşıma: kayıt sahibi teslim edilmiş işi yeni cüzdana taşır.
    let rotated = Keypair::new();
    w.rotate_wallet(&agent, rotated.pubkey())
        .expect("update_agent");
    let ix = w.sync_ix(&agent.owner.pubkey(), &job, agent.record);
    meter.run(
        &mut w.h,
        &["syncAgentWallet"],
        "",
        vec![ix],
        &[&agent.owner],
    );

    // Policy'siz iş: iptal ve release. Payee'nin ATA'sı finalize tx'inde açılır.
    let fresh = w.register_agent("fresh-agent");
    w.screen(&fresh.wallet.pubkey(), ScreeningStatus::Clear);
    let open_spec = [0x61; 32];
    let ix = w.create_job_ix(
        &key.pubkey(),
        fresh.record,
        None,
        open_spec,
        AMOUNT,
        w.h.now() + 7 * DAY,
        CHALLENGE,
        usdc,
    );
    meter.run(&mut w.h, &["createJob"], "policy'siz", vec![ix], &[&key]);
    let open_job = job_address(&key.pubkey(), &open_spec);
    let ix = w.fund_job_ix(&institution, &open_job);
    w.h.send(&[ix], &[&key]).expect("fund_job");
    let ix = w.cancel_ix(
        &key.pubkey(),
        &open_job,
        institution.token_account,
        vault_address(&open_job),
        payer,
    );
    meter.run(&mut w.h, &["cancelJob"], "fonlanmış iş", vec![ix], &[&key]);

    let spec = [0x62; 32];
    let ix = w.create_job_ix(
        &key.pubkey(),
        fresh.record,
        None,
        spec,
        AMOUNT,
        w.h.now() + 7 * DAY,
        CHALLENGE,
        usdc,
    );
    w.h.send(&[ix], &[&key]).expect("create_job");
    let job = job_address(&key.pubkey(), &spec);
    let ix = w.fund_job_ix(&institution, &job);
    w.h.send(&[ix], &[&key]).expect("fund_job");
    let ix = w.accept_ix(&fresh.wallet.pubkey(), &job, fresh.record, spec);
    w.h.send(&[ix], &[&fresh.wallet]).expect("accept_job");
    let ix = w.submit_ix(&fresh.wallet.pubkey(), &job, fresh.record, &delivery_uri);
    w.h.send(&[ix], &[&fresh.wallet]).expect("submit_work");
    w.h.set_time(w.job(&job).challenge_end);
    let keeper = w.h.funded(LAMPORTS);
    let settlement = Settlement {
        payee: fresh.wallet.pubkey(),
        payee_token_account: token::ata_address(&fresh.wallet.pubkey(), &usdc),
        institution_token_account: institution.token_account,
        keeper_token_account: token::create_ata(&mut w.h, &keeper.pubkey(), &usdc),
    };
    let finalize = vec![
        open_ata(&keeper.pubkey(), &fresh.wallet.pubkey(), &usdc),
        open_ata(&keeper.pubkey(), &key.pubkey(), &usdc),
        w.finalize_ix(&keeper.pubkey(), &job, settlement, None),
    ];
    meter.run(
        &mut w.h,
        &["finalizePayment"],
        "policy'siz, payee'nin ATA'sı açılır",
        finalize,
        &[&keeper],
    );
    (meter.rows, plain_depth)
}

/// Adım 7 ve policy'li release: gerçek Groth16 ispatı, ödeme ve `record_release` CPI'ı.
fn proof_and_gated_release(profile: &Profile) -> Vec<Row> {
    let mut r = ReleaseWorld::new(true);
    let mut meter = Meter::new(profile, &mut r.w.h, r.w.usdc);
    let usdc = r.w.usdc;
    let key = r.institution.key.insecure_clone();
    let job = r.delivered_job("a");
    r.w.h.set_time(r.proof_time());

    let ix = r.bind_ix(&key.pubkey(), &job, r.policy.policy, &r.proof("compliant"));
    meter.run(
        &mut r.w.h,
        &["setComplianceProof"],
        "Groth16, 13 sinyal",
        vec![ix],
        &[&key],
    );

    let keeper = r.w.h.funded(LAMPORTS);
    let payee = r.agent.wallet.pubkey();
    let settlement = Settlement {
        payee,
        payee_token_account: token::ata_address(&payee, &usdc),
        institution_token_account: r.institution.token_account,
        keeper_token_account: token::create_ata(&mut r.w.h, &keeper.pubkey(), &usdc),
    };
    let finalize = vec![
        open_ata(&keeper.pubkey(), &payee, &usdc),
        open_ata(&keeper.pubkey(), &key.pubkey(), &usdc),
        r.w.finalize_ix(&keeper.pubkey(), &job, settlement, Some(r.gate(&job))),
    ];
    meter.run(
        &mut r.w.h,
        &["finalizePayment"],
        "policy'li, record_release CPI, payee'nin ATA'sı açılır",
        finalize,
        &[&keeper],
    );
    meter.rows
}

#[test]
fn every_step_fits_the_packet_and_its_compute_profile() {
    let profile = profile();
    let (rows, plain_depth) = institution_agent_job_and_claim(&profile);
    let rows: Vec<Row> = rows
        .into_iter()
        .chain(proof_and_gated_release(&profile))
        .collect();
    print_table(&rows);
    println!(
        "\nALT'sız alımda pakete sığan en uzun kanıt: {plain_depth} kardeş (en çok {} alıcı); sınır {MAX_BUYER_PROOF_DEPTH}.",
        1u64 << plain_depth
    );

    // Profildeki her tx türü en az bir kez ölçüldü.
    for kind in profile.limits.keys() {
        assert!(
            rows.iter()
                .any(|row| row.kinds.split(" + ").any(|k| k == kind)),
            "profildeki {kind} ölçülmedi"
        );
    }
}
