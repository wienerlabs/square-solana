use anyhow::{Context, Result};
use risc0_zkvm::{default_prover, ExecutorEnv, Receipt};
use aperture_payment_prover_core::{ProverInput, ProverOutput};
use aperture_payment_prover_methods::GUEST_CODE_FOR_Aperture_PAYMENT_PROVER_GUEST_ID;

pub struct PaymentProver;

pub struct PaymentProofResult {
    pub output: ProverOutput,
    pub receipt: Receipt,
    pub image_id: [u32; 8],
}

impl PaymentProver {
    pub fn prove(input: &ProverInput) -> Result<PaymentProofResult> {
        let env = ExecutorEnv::builder()
            .write(input)
            .context("Failed to write input to executor env")?
            .build()
            .context("Failed to build executor env")?;

        let prover = default_prover();
        let receipt = prover
            .prove(env, GUEST_CODE_FOR_Aperture_PAYMENT_PROVER_GUEST_ID)
            .context("Failed to generate proof")?
            .receipt;

        let output: ProverOutput = receipt
            .journal
            .decode()
            .context("Failed to decode journal output")?;

        receipt
            .verify(GUEST_CODE_FOR_Aperture_PAYMENT_PROVER_GUEST_ID)
            .context("Receipt verification failed")?;

        Ok(PaymentProofResult {
            output,
            receipt,
            image_id: GUEST_CODE_FOR_Aperture_PAYMENT_PROVER_GUEST_ID,
        })
    }

    pub fn verify(receipt: &Receipt) -> Result<ProverOutput> {
        receipt
            .verify(GUEST_CODE_FOR_Aperture_PAYMENT_PROVER_GUEST_ID)
            .context("Receipt verification failed")?;

        let output: ProverOutput = receipt
            .journal
            .decode()
            .context("Failed to decode journal output")?;

        Ok(output)
    }

    pub fn image_id() -> [u32; 8] {
        GUEST_CODE_FOR_Aperture_PAYMENT_PROVER_GUEST_ID
    }

    pub fn extract_receipt_bytes(receipt: &Receipt) -> Result<Vec<u8>> {
        let bytes =
            bincode::serialize(receipt).context("Failed to serialize receipt")?;
        Ok(bytes)
    }

    pub fn receipt_from_bytes(bytes: &[u8]) -> Result<Receipt> {
        let receipt: Receipt =
            bincode::deserialize(bytes).context("Failed to deserialize receipt")?;
        Ok(receipt)
    }
}
