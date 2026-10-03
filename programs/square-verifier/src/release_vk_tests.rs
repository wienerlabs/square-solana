//! `SQUARE_RELEASE_VK`, programın kullandığı groth16-solana ile gerçek bir ispatı doğruluyor ve
//! değiştirilmiş bir ispatı ya da public sinyali reddediyor mu (BC-20). İspat
//! `release_vk_vector.rs`'te; pipeline (circuits/payment-compliance/scripts/release-artifacts.mjs)
//! üretir.

use groth16_solana::groth16::Groth16Verifier;

use crate::release_vk::{RELEASE_NR_INPUTS, SQUARE_RELEASE_VK};
use crate::release_vk_vector::{
    RELEASE_PROOF_A, RELEASE_PROOF_B, RELEASE_PROOF_C, RELEASE_PUBLIC_INPUTS,
};

fn verifies(
    proof_a: &[u8; 64],
    proof_b: &[u8; 128],
    proof_c: &[u8; 64],
    public_inputs: &[[u8; 32]; RELEASE_NR_INPUTS],
) -> bool {
    Groth16Verifier::<RELEASE_NR_INPUTS>::new(
        proof_a,
        proof_b,
        proof_c,
        public_inputs,
        &SQUARE_RELEASE_VK,
    )
    .is_ok_and(|mut verifier| verifier.verify().is_ok())
}

#[test]
fn key_has_one_ic_point_per_public_signal() {
    assert_eq!(SQUARE_RELEASE_VK.nr_pubinputs, RELEASE_NR_INPUTS);
    assert_eq!(SQUARE_RELEASE_VK.vk_ic.len(), RELEASE_NR_INPUTS + 1);
}

#[test]
fn accepts_real_release_proof() {
    assert!(verifies(
        &RELEASE_PROOF_A,
        &RELEASE_PROOF_B,
        &RELEASE_PROOF_C,
        &RELEASE_PUBLIC_INPUTS
    ));
}

#[test]
fn rejects_each_changed_public_signal() {
    for index in 0..RELEASE_NR_INPUTS {
        let mut inputs = RELEASE_PUBLIC_INPUTS;
        inputs[index][31] ^= 1;
        assert!(
            !verifies(
                &RELEASE_PROOF_A,
                &RELEASE_PROOF_B,
                &RELEASE_PROOF_C,
                &inputs
            ),
            "signal {index} changed but the proof still verified"
        );
    }
}

#[test]
fn rejects_tampered_proof() {
    let mut proof_c = RELEASE_PROOF_C;
    proof_c[63] ^= 1;
    assert!(!verifies(
        &RELEASE_PROOF_A,
        &RELEASE_PROOF_B,
        &proof_c,
        &RELEASE_PUBLIC_INPUTS
    ));

    let mut proof_a = RELEASE_PROOF_A;
    proof_a[0] ^= 1;
    assert!(!verifies(
        &proof_a,
        &RELEASE_PROOF_B,
        &RELEASE_PROOF_C,
        &RELEASE_PUBLIC_INPUTS
    ));
}
