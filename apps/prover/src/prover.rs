use anyhow::{Context, Result};
use risc0_zkvm::{default_prover, ExecutorEnv};
use tracing::info;
use aperture_payment_prover_core::{ProverInput, ProverOutput};
use aperture_payment_prover_methods::Aperture_PAYMENT_PROVER_GUEST_ELF;

pub struct ProofResult {
    pub output: ProverOutput,
    pub receipt_bytes: Vec<u8>,
    pub image_id: [u32; 8],
}

pub async fn generate_proof(input: ProverInput) -> Result<ProofResult> {
    // Run proving in a blocking task since RISC Zero proving is CPU-intensive
    tokio::task::spawn_blocking(move || generate_proof_blocking(input))
        .await
        .context("Proving task panicked")?
}

fn generate_proof_blocking(input: ProverInput) -> Result<ProofResult> {
    info!(
        policy_id = %input.policy_id,
        operator_id = %input.operator_id,
        "Building executor environment for zkVM"
    );

    // Build the executor environment with the prover input
    let env = ExecutorEnv::builder()
        .write(&input)
        .context("Failed to write input to executor environment")?
        .build()
        .context("Failed to build executor environment")?;

    // Get the default prover (uses CPU proving; GPU can be enabled via features)
    let prover = default_prover();

    info!("Starting RISC Zero proof generation");

    // Run the guest program in the zkVM and generate a proof
    let receipt = prover
        .prove(env, Aperture_PAYMENT_PROVER_GUEST_ELF)
        .context("Failed to generate ZK proof in RISC Zero zkVM")?
        .receipt;

    // Verify the receipt locally before returning
    receipt
        .verify(aperture_payment_prover_methods::Aperture_PAYMENT_PROVER_GUEST_ID)
        .context("Receipt verification failed")?;

    info!("Receipt verified successfully");

    // Decode the journal output from the receipt
    let output: ProverOutput = receipt
        .journal
        .decode()
        .context("Failed to decode journal output from receipt")?;

    info!(
        is_compliant = output.is_compliant,
        proof_hash = %output.proof_hash,
        "Proof output decoded from receipt journal"
    );

    // Serialize the receipt to bytes for transport
    let receipt_bytes =
        bincode::serialize(&receipt).context("Failed to serialize receipt to bytes")?;

    let image_id = aperture_payment_prover_methods::Aperture_PAYMENT_PROVER_GUEST_ID;

    Ok(ProofResult {
        output,
        receipt_bytes,
        image_id,
    })
}
