use risc0_zkvm::guest::env;
use aperture_payment_prover_core::{
    compute_amount_range, compute_journal_digest, compute_proof_hash, verify_compliance,
    ProverInput, ProverOutput, AMOUNT_BUCKET_SIZE,
};

fn main() {
    let input: ProverInput = env::read();

    let (is_compliant, _reason) = verify_compliance(&input);

    let proof_hash = compute_proof_hash(&input);

    let (amount_range_min, amount_range_max) = if is_compliant {
        compute_amount_range(input.payment_amount_lamports, AMOUNT_BUCKET_SIZE)
    } else {
        (0, 0)
    };

    let verification_timestamp = input.payment_timestamp.clone();

    let journal_digest = compute_journal_digest(
        is_compliant,
        &proof_hash,
        amount_range_min,
        amount_range_max,
        &verification_timestamp,
    );

    let output = ProverOutput {
        is_compliant,
        proof_hash,
        amount_range_min,
        amount_range_max,
        verification_timestamp,
        journal_digest,
    };

    env::commit(&output);
}
