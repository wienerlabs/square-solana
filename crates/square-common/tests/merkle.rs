//! Alıcı Merkle doğrulaması (BC-18). Kanıtlar `@squaresdk/solana-policy`'nin ürettiği vektörlerden
//! (`tests/fixtures/buyer-merkle-vectors.json`, `packages/policy/scripts/buyer-vectors.mjs`) gelir.

use anchor_lang::prelude::Pubkey;
use serde_json::Value;
use square_common::merkle::{
    buyer_leaf, is_unrestricted, parent, verify_buyer_proof, MAX_BUYER_PROOF_DEPTH,
    UNRESTRICTED_ROOT,
};

fn bytes32(v: &Value) -> [u8; 32] {
    let text = v.as_str().expect("hex");
    let mut out = [0u8; 32];
    for (i, chunk) in text.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap();
    }
    out
}

struct Buyer {
    buyer: Pubkey,
    salt: [u8; 32],
    proof: Vec<[u8; 32]>,
}

struct Tree {
    size: u64,
    root: [u8; 32],
    buyers: Vec<Buyer>,
}

fn trees() -> Vec<Tree> {
    let doc: Value =
        serde_json::from_str(include_str!("fixtures/buyer-merkle-vectors.json")).unwrap();
    doc["trees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| Tree {
            size: t["size"].as_u64().unwrap(),
            root: bytes32(&t["root"]),
            buyers: t["buyers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| Buyer {
                    buyer: Pubkey::new_from_array(bytes32(&b["buyer"])),
                    salt: bytes32(&b["leafSalt"]),
                    proof: b["proof"].as_array().unwrap().iter().map(bytes32).collect(),
                })
                .collect(),
        })
        .collect()
}

#[test]
fn every_listed_buyer_verifies_against_the_typescript_root() {
    let trees = trees();
    assert_eq!(
        trees.iter().map(|t| t.size).collect::<Vec<_>>(),
        vec![1, 2, 3, 5, 8, 17]
    );
    for tree in &trees {
        assert_eq!(tree.buyers.len() as u64, tree.size);
        for b in &tree.buyers {
            assert!(
                verify_buyer_proof(&tree.root, &b.buyer, &b.salt, &b.proof),
                "{} alıcılı ağaç",
                tree.size
            );
        }
    }
}

#[test]
fn single_buyer_root_is_the_leaf_and_odd_node_is_carried_up() {
    let trees = trees();
    let single = &trees[0];
    assert_eq!(
        single.root,
        buyer_leaf(&single.buyers[0].buyer, &single.buyers[0].salt)
    );
    assert!(single.buyers[0].proof.is_empty());
    // Üç yapraklı ağaç: kök = parent(parent(l0, l1), l2); l2'nin kanıtında tek kardeş var.
    let three = &trees[2];
    let leaves: Vec<[u8; 32]> = three
        .buyers
        .iter()
        .map(|b| buyer_leaf(&b.buyer, &b.salt))
        .collect();
    assert_eq!(
        three.root,
        parent(&parent(&leaves[0], &leaves[1]), &leaves[2])
    );
    assert_eq!(three.buyers[2].proof.len(), 1);
}

#[test]
fn rejects_wrong_salt_buyer_proof_and_root() {
    let trees = trees();
    let tree = trees.iter().find(|t| t.size == 17).unwrap();
    let (a, b) = (&tree.buyers[3], &tree.buyers[11]);
    // Yanlış salt, başka alıcının anahtarı, başka alıcının kanıtı.
    assert!(!verify_buyer_proof(&tree.root, &a.buyer, &b.salt, &a.proof));
    assert!(!verify_buyer_proof(&tree.root, &b.buyer, &a.salt, &a.proof));
    assert!(!verify_buyer_proof(&tree.root, &a.buyer, &a.salt, &b.proof));
    // Kanıtın bir düğümünde tek bit, eksik düğüm, başka ağacın kökü.
    let mut flipped = a.proof.clone();
    flipped[1][0] ^= 1;
    assert!(!verify_buyer_proof(&tree.root, &a.buyer, &a.salt, &flipped));
    assert!(!verify_buyer_proof(
        &tree.root,
        &a.buyer,
        &a.salt,
        &a.proof[..a.proof.len() - 1]
    ));
    let other = trees.iter().find(|t| t.size == 8).unwrap();
    assert!(!verify_buyer_proof(
        &other.root,
        &a.buyer,
        &a.salt,
        &a.proof
    ));
    // Listede olmayan alıcı.
    let stranger = Pubkey::new_from_array([0xab; 32]);
    assert!(!verify_buyer_proof(
        &tree.root, &stranger, &a.salt, &a.proof
    ));
}

#[test]
fn rejects_proofs_longer_than_the_limit() {
    let trees = trees();
    let tree = trees.iter().find(|t| t.size == 2).unwrap();
    let b = &tree.buyers[0];
    // Kök, uzun bir kanıtın sonucuna eşit olsa bile 16'dan uzun kanıt kabul edilmez.
    let long: Vec<[u8; 32]> = vec![[7; 32]; MAX_BUYER_PROOF_DEPTH + 1];
    let forged_root = long
        .iter()
        .fold(buyer_leaf(&b.buyer, &b.salt), |n, s| parent(&n, s));
    assert!(!verify_buyer_proof(&forged_root, &b.buyer, &b.salt, &long));
    let at_limit = &long[..MAX_BUYER_PROOF_DEPTH];
    let root_at_limit = at_limit
        .iter()
        .fold(buyer_leaf(&b.buyer, &b.salt), |n, s| parent(&n, s));
    assert!(verify_buyer_proof(
        &root_at_limit,
        &b.buyer,
        &b.salt,
        at_limit
    ));
}

#[test]
fn zero_root_is_unrestricted() {
    assert!(is_unrestricted(&UNRESTRICTED_ROOT));
    let anyone = Pubkey::new_from_array([1; 32]);
    assert!(verify_buyer_proof(
        &UNRESTRICTED_ROOT,
        &anyone,
        &[0; 32],
        &[]
    ));
    assert!(!is_unrestricted(&trees()[0].root));
}
