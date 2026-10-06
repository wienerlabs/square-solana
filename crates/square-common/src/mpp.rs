//! Stripe MPP fiat rayının attestation'ı (BC-37, ADR 0024). Fiat işte ödeme zincir dışında Stripe ile
//! yapılır; doğrulanmış Stripe webhook'unu alan servis (MPP authority) makbuzun Poseidon commitment'ını
//! işe ve tutara bağlayan mesajı ed25519 ile imzalar. Verifier imzayı aynı tx'teki Ed25519 precompile
//! talimatından okur; anahtar `VerifierConfig.mpp_authority`'dir.
//!
//! - mesaj: `"square/mpp-attestation/v1" ‖ job ‖ stripe_receipt_hash ‖ amount (u64, little-endian)`
//! - `job` imzayı tek bir işe, `amount` (settlement mint'inin taban birimi) işin tutarına bağlar.
//! - Precompile talimatı tek imza taşır ve imza, anahtar ve mesajın hepsi talimatın kendi verisindedir
//!   (`*_instruction_index == u16::MAX`); başka bir talimatın baytlarına yönlendirme kabul edilmez.

use anchor_lang::prelude::Pubkey;

/// Mesajın alan ayırıcısı (sürümlü).
pub const DOMAIN: &[u8] = b"square/mpp-attestation/v1";

/// Mesajın uzunluğu: ayırıcı, job, makbuz commitment'ı ve tutar.
pub const MESSAGE_LEN: usize = DOMAIN.len() + 32 + 32 + 8;

/// İmzalanan mesaj.
pub fn attestation_message(
    job: &Pubkey,
    stripe_receipt_hash: &[u8; 32],
    amount: u64,
) -> [u8; MESSAGE_LEN] {
    let mut message = [0; MESSAGE_LEN];
    let (domain, rest) = message.split_at_mut(DOMAIN.len());
    domain.copy_from_slice(DOMAIN);
    let (job_bytes, rest) = rest.split_at_mut(32);
    job_bytes.copy_from_slice(job.as_ref());
    let (hash, amount_bytes) = rest.split_at_mut(32);
    hash.copy_from_slice(stripe_receipt_hash);
    amount_bytes.copy_from_slice(&amount.to_le_bytes());
    message
}

/// Ed25519 precompile talimatının çözümlenmesindeki hata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationError {
    /// Başlık, imza sayısı ya da ofsetler geçersiz.
    Malformed,
    /// İmza, anahtar ya da mesaj başka bir talimatın verisinden okunuyor.
    Redirected,
    /// İmzalayan beklenen anahtar değil.
    WrongSigner,
    /// İmzalanan mesaj beklenen mesaj değil.
    WrongMessage,
}

const HEADER_LEN: usize = 2;
const OFFSETS_LEN: usize = 14;
/// Ofsetin aynı talimatın verisini gösterdiği talimat indeksi.
const THIS_INSTRUCTION: u16 = u16::MAX;

fn u16_at(data: &[u8], offset: usize) -> Result<u16, AttestationError> {
    data.get(offset..offset + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or(AttestationError::Malformed)
}

fn slice(data: &[u8], offset: u16, len: usize) -> Result<&[u8], AttestationError> {
    let start = usize::from(offset);
    data.get(start..start + len)
        .ok_or(AttestationError::Malformed)
}

/// Ed25519 precompile talimatının verisi `signer`'ın `message` üzerindeki tek imzasını taşıyor mu.
/// İmzanın kendisini precompile doğrular; tx'e girmiş talimatın imzası geçerlidir.
///
/// Düzen: `num_signatures: u8`, `padding: u8`, ardından imza başına 14 bayt
/// (`signature_offset`, `signature_instruction_index`, `public_key_offset`,
/// `public_key_instruction_index`, `message_data_offset`, `message_data_size`,
/// `message_instruction_index`; hepsi u16 little-endian).
pub fn verify_ed25519_instruction(
    data: &[u8],
    signer: &Pubkey,
    message: &[u8],
) -> Result<(), AttestationError> {
    if data.len() < HEADER_LEN + OFFSETS_LEN || data[0] != 1 {
        return Err(AttestationError::Malformed);
    }
    let field = |i: usize| u16_at(data, HEADER_LEN + 2 * i);
    let signature_offset = field(0)?;
    let signature_index = field(1)?;
    let public_key_offset = field(2)?;
    let public_key_index = field(3)?;
    let message_offset = field(4)?;
    let message_size = field(5)?;
    let message_index = field(6)?;
    if [signature_index, public_key_index, message_index] != [THIS_INSTRUCTION; 3] {
        return Err(AttestationError::Redirected);
    }
    slice(data, signature_offset, 64)?;
    if slice(data, public_key_offset, 32)? != signer.as_ref() {
        return Err(AttestationError::WrongSigner);
    }
    if slice(data, message_offset, usize::from(message_size))? != message {
        return Err(AttestationError::WrongMessage);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Solana'nın `new_ed25519_instruction` düzeni: başlık, ofsetler, anahtar, imza, mesaj.
    fn instruction(signer: &Pubkey, message: &[u8]) -> Vec<u8> {
        let public_key_offset = (HEADER_LEN + OFFSETS_LEN) as u16;
        let signature_offset = public_key_offset + 32;
        let message_offset = signature_offset + 64;
        let mut data = vec![1, 0];
        for value in [
            signature_offset,
            u16::MAX,
            public_key_offset,
            u16::MAX,
            message_offset,
            message.len() as u16,
            u16::MAX,
        ] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.extend_from_slice(signer.as_ref());
        data.extend_from_slice(&[7; 64]);
        data.extend_from_slice(message);
        data
    }

    #[test]
    fn the_message_binds_domain_job_receipt_and_amount() {
        let job = Pubkey::new_from_array([1; 32]);
        let message = attestation_message(&job, &[2; 32], 0x0102_0304_0506_0708);
        assert_eq!(MESSAGE_LEN, 97);
        assert_eq!(&message[..DOMAIN.len()], DOMAIN);
        assert_eq!(&message[25..57], &[1; 32]);
        assert_eq!(&message[57..89], &[2; 32]);
        assert_eq!(&message[89..], &[8, 7, 6, 5, 4, 3, 2, 1]);
    }

    #[test]
    fn accepts_a_self_contained_signature_of_the_expected_signer_and_message() {
        let signer = Pubkey::new_from_array([3; 32]);
        let message = attestation_message(&Pubkey::new_from_array([4; 32]), &[5; 32], 25);
        let data = instruction(&signer, &message);
        assert_eq!(verify_ed25519_instruction(&data, &signer, &message), Ok(()));
    }

    #[test]
    fn rejects_other_signers_messages_and_redirections() {
        let signer = Pubkey::new_from_array([3; 32]);
        let message = attestation_message(&Pubkey::new_from_array([4; 32]), &[5; 32], 25);
        let data = instruction(&signer, &message);
        let other = Pubkey::new_from_array([9; 32]);
        assert_eq!(
            verify_ed25519_instruction(&data, &other, &message),
            Err(AttestationError::WrongSigner)
        );
        let other_amount = attestation_message(&Pubkey::new_from_array([4; 32]), &[5; 32], 26);
        assert_eq!(
            verify_ed25519_instruction(&data, &signer, &other_amount),
            Err(AttestationError::WrongMessage)
        );
        // Mesaj başka bir talimattan okunuyor.
        let mut redirected = data.clone();
        redirected[HEADER_LEN + 12..HEADER_LEN + 14].copy_from_slice(&0u16.to_le_bytes());
        assert_eq!(
            verify_ed25519_instruction(&redirected, &signer, &message),
            Err(AttestationError::Redirected)
        );
    }

    #[test]
    fn rejects_malformed_instructions() {
        let signer = Pubkey::new_from_array([3; 32]);
        let message = attestation_message(&Pubkey::new_from_array([4; 32]), &[5; 32], 25);
        let data = instruction(&signer, &message);
        assert_eq!(
            verify_ed25519_instruction(&data[..10], &signer, &message),
            Err(AttestationError::Malformed)
        );
        let mut two = data.clone();
        two[0] = 2;
        assert_eq!(
            verify_ed25519_instruction(&two, &signer, &message),
            Err(AttestationError::Malformed)
        );
        // Mesaj verinin dışına taşıyor.
        let truncated = &data[..data.len() - 1];
        assert_eq!(
            verify_ed25519_instruction(truncated, &signer, &message),
            Err(AttestationError::Malformed)
        );
    }
}
