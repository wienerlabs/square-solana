//! Travel Rule commitment'ı (BC-34, ADR 0015). Vektörler `@squaresdk/solana-sdk`'nın uygulamasından
//! (`tests/fixtures/travel-rule-vectors.json`, `packages/sdk/scripts/travel-rule-vectors.mjs`) gelir.

use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use serde_json::Value;
use solana_sha256_hasher::hash;
use square_common::travel_rule::{commitment, is_bound, required, DOMAIN, NONE};

fn bytes32(v: &Value) -> [u8; 32] {
    let text = v.as_str().expect("hex");
    let mut out = [0u8; 32];
    for (i, chunk) in text.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap();
    }
    out
}

struct Vector {
    label: String,
    job: Pubkey,
    salt: [u8; 32],
    canonical: String,
    record_digest: [u8; 32],
    commitment: [u8; 32],
}

fn vectors() -> (String, Vec<Vector>) {
    let doc: Value =
        serde_json::from_str(include_str!("fixtures/travel-rule-vectors.json")).unwrap();
    let vectors = doc["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| Vector {
            label: v["label"].as_str().unwrap().to_string(),
            job: Pubkey::from_str(v["job"].as_str().unwrap()).unwrap(),
            salt: bytes32(&v["salt"]),
            canonical: v["canonical"].as_str().unwrap().to_string(),
            record_digest: bytes32(&v["recordDigest"]),
            commitment: bytes32(&v["commitment"]),
        })
        .collect();
    (doc["domain"].as_str().unwrap().to_string(), vectors)
}

#[test]
fn the_sdk_vectors_match_the_on_chain_commitment() {
    let (domain, vectors) = vectors();
    assert_eq!(domain.as_bytes(), DOMAIN);
    assert_eq!(vectors.len(), 3);
    for v in &vectors {
        assert_eq!(
            hash(v.canonical.as_bytes()).to_bytes(),
            v.record_digest,
            "{}: kaydın özeti",
            v.label
        );
        assert_eq!(
            commitment(&v.job, &v.salt, &v.record_digest),
            v.commitment,
            "{}: commitment",
            v.label
        );
        assert!(is_bound(&v.commitment));
    }
}

#[test]
fn the_commitment_binds_the_job_the_salt_and_the_record() {
    let (_, vectors) = vectors();
    let v = &vectors[0];
    let other = &vectors[1];
    assert_ne!(
        commitment(&other.job, &v.salt, &v.record_digest),
        v.commitment
    );
    assert_ne!(
        commitment(&v.job, &other.salt, &v.record_digest),
        v.commitment
    );
    assert_ne!(
        commitment(&v.job, &v.salt, &other.record_digest),
        v.commitment
    );
}

#[test]
fn the_threshold_requires_a_commitment_at_or_above_it_and_zero_disables_it() {
    assert!(!required(u64::MAX, 0), "eşik 0: kapalı");
    assert!(!required(999, 1_000));
    assert!(required(1_000, 1_000), "eşiğe eşit tutar");
    assert!(required(1_001, 1_000));
    assert!(!is_bound(&NONE));
}
