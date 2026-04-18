use groth16_solana::groth16::Groth16Verifyingkey;

/// Number of public inputs for the payment-prover Groth16 circuit.
///
/// RISC Zero encodes the claim digest (image_id + journal digest commitment)
/// into the public inputs. The exact count depends on how Step B wires up
/// the STARK-to-SNARK wrapper. Adjust if the real VK requires a different
/// count.
pub const PAYMENT_NR_INPUTS: usize = 2;

/// Number of public inputs for the batch-aggregator Groth16 circuit.
pub const BATCH_NR_INPUTS: usize = 2;

/// Groth16 verification key for the Aperture RISC Zero payment-prover guest.
///
/// This is a placeholder and MUST be replaced with the real verification key
/// derived from the RISC Zero guest ELF before mainnet deployment. The real
/// VK is obtained by running `ProverOpts::groth16()` against the compiled
/// guest and extracting the verification key via RISC Zero tooling.
///
/// The current zeroed state will cause verification to fail, which is the
/// intended safe default until the real key is wired up in Step B.
pub const APERTURE_PAYMENT_VK: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: PAYMENT_NR_INPUTS,
    vk_alpha_g1: [0u8; 64],
    vk_beta_g2: [0u8; 128],
    vk_gamme_g2: [0u8; 128],
    vk_delta_g2: [0u8; 128],
    vk_ic: &[],
};

/// Groth16 verification key for the Aperture RISC Zero batch-aggregator guest.
///
/// Same placeholder semantics as APERTURE_PAYMENT_VK.
pub const APERTURE_BATCH_VK: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: BATCH_NR_INPUTS,
    vk_alpha_g1: [0u8; 64],
    vk_beta_g2: [0u8; 128],
    vk_gamme_g2: [0u8; 128],
    vk_delta_g2: [0u8; 128],
    vk_ic: &[],
};
