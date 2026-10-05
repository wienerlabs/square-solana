//! square_verifier hata kodları (program arayüzü §10.3). Sıra sözleşmedir: kodlar 6000'den başlar ve
//! istemciler hatayı (program kimliği, kod) çiftiyle eşler.

use anchor_lang::prelude::*;

#[error_code]
pub enum VerifierError {
    #[msg("Groth16 proof verification failed")]
    InvalidProof,
    #[msg("Job has no policy or references a different policy")]
    PolicyMismatch,
    #[msg("Proof commitment or ceiling does not match the job's policy snapshot")]
    SnapshotMismatch,
    #[msg("Proof payee does not match the address the escrow will pay")]
    PayeeMismatch,
    #[msg("Proof mint does not match the job mint")]
    MintMismatch,
    #[msg("Proof was built against an outdated daily counter or clock")]
    StaleProof,
    #[msg("Release proof already consumed")]
    ProofAlreadyConsumed,
    #[msg("Signer is not authorized for this operation")]
    Unauthorized,
    #[msg("Account owner or seeds do not match the linked program")]
    InvalidLinkedAccount,
    #[msg("Job is not in a state that accepts a release proof")]
    InvalidJobState,
    #[msg("MPP attestation missing or signed by an unexpected key")]
    InvalidMppAttestation,
}
