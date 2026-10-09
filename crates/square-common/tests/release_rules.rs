//! Release kuralları (ADR 0012, ADR 0013): ret kodu, kesin ret, günlük sayaç ve tazelik. Beklenen
//! değerler `@squaresdk/solana-policy`'nin ürettiği vektörlerden (`tests/fixtures/release-rule-vectors.json`,
//! `packages/policy/scripts/release-vectors.mjs`) gelir; iki uygulama aynı kararları vermelidir.

use anchor_lang::prelude::Pubkey;
use serde_json::Value;
use square_common::contract::square_verifier_contract::accounts::{OperatorState, ReleaseProof};
use square_common::contract::square_verifier_contract::types::ReleaseVerdict;
use square_common::release::{
    check_fresh, daily_spent_at, is_final_refusal, preflight_accepts, refusal, ReleaseFacts,
    Staleness,
};

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/release-rule-vectors.json")).unwrap()
}

fn key(v: &Value) -> Pubkey {
    let text = v.as_str().expect("hex");
    let mut out = [0u8; 32];
    for (i, chunk) in text.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap();
    }
    Pubkey::new_from_array(out)
}

fn u64_of(v: &Value) -> u64 {
    v.as_str().expect("decimal string").parse().unwrap()
}

/// TypeScript'teki kural adının Rust'taki biti.
fn rule_bit(name: &str) -> u16 {
    match name {
        "perTx" => refusal::PER_TX,
        "dailyPrivate" => refusal::DAILY_PRIVATE,
        "mintNotAllowed" => refusal::MINT_NOT_ALLOWED,
        "payeeBlocked" => refusal::PAYEE_BLOCKED,
        "categoryNotAllowed" => refusal::CATEGORY_NOT_ALLOWED,
        "outsideTimeWindow" => refusal::OUTSIDE_TIME_WINDOW,
        "dailyCeiling" => refusal::DAILY_CEILING,
        other => panic!("bilinmeyen kural: {other}"),
    }
}

fn staleness(name: &str) -> Staleness {
    match name {
        "payee" => Staleness::Payee,
        "netAmount" => Staleness::NetAmount,
        "mint" => Staleness::Mint,
        "day" => Staleness::Day,
        "dailyCounter" => Staleness::DailyCounter,
        other => panic!("bilinmeyen bayatlık: {other}"),
    }
}

#[test]
fn refusal_rules_and_finality_match_typescript() {
    let doc = vectors();
    let cases = doc["refusals"].as_array().unwrap();
    assert_eq!(cases.len(), 256, "128 kod × 2 sayaç");
    for case in cases {
        let code = case["code"].as_u64().unwrap() as u16;
        let daily_spent_before = u64_of(&case["dailySpentBefore"]);
        // Kural adları bit sırasıyla ve kodun bitlerinin tamamı.
        let bits: Vec<u16> = case["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| rule_bit(r.as_str().unwrap()))
            .collect();
        assert!(bits.windows(2).all(|w| w[0] < w[1]), "kod {code}");
        assert_eq!(bits.iter().fold(0, |m, b| m | b), code, "kod {code}");
        assert_eq!(
            is_final_refusal(code, daily_spent_before),
            case["final"].as_bool().unwrap(),
            "kod {code}, sayaç {daily_spent_before}"
        );
        // Kabul öncesi ön-ispat (ADR 0028) sayaçtan bağımsızdır.
        assert_eq!(
            preflight_accepts(code),
            case["preflight"].as_bool().unwrap(),
            "kod {code}"
        );
    }
}

#[test]
fn daily_counter_matches_typescript() {
    let doc = vectors();
    for case in doc["dailySpentAt"].as_array().unwrap() {
        let expected = case["expected"].as_str().map(|s| s.parse::<u64>().unwrap());
        assert_eq!(
            daily_spent_at(
                case["dayStartUnix"].as_i64().unwrap(),
                u64_of(&case["dailySpent"]),
                case["at"].as_i64().unwrap(),
            ),
            expected,
            "{}",
            case["name"]
        );
    }
}

#[test]
fn freshness_matches_typescript() {
    let doc = vectors();
    let cases = doc["fresh"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let p = &case["proof"];
        let proof = ReleaseProof {
            job: Pubkey::new_from_array([1; 32]),
            institution: Pubkey::new_from_array([2; 32]),
            policy: Pubkey::new_from_array([3; 32]),
            payee: key(&p["payee"]),
            net_amount: u64_of(&p["netAmount"]),
            mint: key(&p["mint"]),
            daily_spent_before: u64_of(&p["dailySpentBefore"]),
            proof_timestamp: p["proofTimestamp"].as_i64().unwrap(),
            verdict: ReleaseVerdict::Compliant,
            refusal_code: 0,
            consumed: false,
            bump: 255,
        };
        let o = &case["operator"];
        let operator = OperatorState {
            institution: Pubkey::new_from_array([2; 32]),
            daily_spent: u64_of(&o["dailySpent"]),
            day_start_unix: o["dayStartUnix"].as_i64().unwrap(),
            total_lifetime_payments: 0,
            bump: 254,
        };
        let t = &case["target"];
        let facts = ReleaseFacts {
            payee: key(&t["payee"]),
            net_amount: u64_of(&t["netAmount"]),
            mint: key(&t["mint"]),
        };
        let expected = match case["expected"].as_str() {
            None => Ok(()),
            Some(name) => Err(staleness(name)),
        };
        assert_eq!(
            check_fresh(&proof, &operator, &facts, case["now"].as_i64().unwrap()),
            expected,
            "{}",
            case["name"]
        );
    }
}
