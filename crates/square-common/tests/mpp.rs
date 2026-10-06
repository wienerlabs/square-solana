//! Stripe MPP attestation'ı (BC-37, ADR 0024). Vektörler `@squaresdk/solana-sdk`'nın uygulamasından
//! (`tests/fixtures/mpp-attestation-vectors.json`, `packages/sdk/scripts/mpp-vectors.mjs`) gelir: mesajın
//! düzeni ve SDK'nın kurduğu Ed25519 precompile talimatı zincirdeki çözümlemeyle aynı olmalı.

use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use serde_json::Value;
use square_common::mpp::{
    attestation_message, verify_ed25519_instruction, AttestationError, DOMAIN,
};

fn bytes(v: &Value) -> Vec<u8> {
    let text = v.as_str().expect("hex");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn the_sdk_vectors_match_the_on_chain_message_and_instruction_layout() {
    let doc: Value =
        serde_json::from_str(include_str!("fixtures/mpp-attestation-vectors.json")).unwrap();
    assert_eq!(doc["domain"].as_str().unwrap().as_bytes(), DOMAIN);
    let authority = Pubkey::from_str(doc["authority"].as_str().unwrap()).unwrap();
    let vectors = doc["vectors"].as_array().unwrap();
    assert!(!vectors.is_empty());
    for v in vectors {
        let label = v["label"].as_str().unwrap();
        let job = Pubkey::from_str(v["job"].as_str().unwrap()).unwrap();
        let receipt: [u8; 32] = bytes(&v["stripeReceiptHash"]).try_into().unwrap();
        let amount: u64 = v["amount"].as_str().unwrap().parse().unwrap();
        let message = attestation_message(&job, &receipt, amount);
        assert_eq!(message.to_vec(), bytes(&v["message"]), "{label}: mesaj");
        let instruction = bytes(&v["instruction"]);
        assert_eq!(
            verify_ed25519_instruction(&instruction, &authority, &message),
            Ok(()),
            "{label}: talimat"
        );
        assert_eq!(
            verify_ed25519_instruction(&instruction, &job, &message),
            Err(AttestationError::WrongSigner),
            "{label}: başka imzacı"
        );
    }
}
