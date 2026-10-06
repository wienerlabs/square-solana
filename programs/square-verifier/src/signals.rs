//! Release devresinin 13 public sinyali (release-circuit.md §2), groth16-solana'nın girdi biçiminde:
//! her sinyal 32 baytlık big-endian BN254 alan elemanı. Sinyallerin 10'unu program hesaplardan kurar
//! (yol A, §6); `refusal_code`, `net_amount` ve `proof_timestamp` ispatı yapanın beyanıdır ve ispat
//! yalnızca bunlar doğruysa doğrulanır. MPP yolunda (BC-37) `refusal_code` 0, `net_amount` işin tutarıdır;
//! `stripe_receipt_hash` MPP authority'nin imzaladığı makbuz commitment'ıdır.

use anchor_lang::prelude::Pubkey;

use crate::release_vk::RELEASE_NR_INPUTS;

pub type Signal = [u8; 32];

/// Escrow release yolunda `stripe_receipt_hash` (sinyal 12).
pub const NO_STRIPE_RECEIPT: Signal = [0; 32];

/// Sinyallerin kaynağı: hesaplardan okunanlar ve ispatı yapanın beyanı.
pub struct ReleaseSignals {
    pub refusal_code: u16,
    pub policy_commitment: [u8; 32],
    pub daily_ceiling: u64,
    pub payee: Pubkey,
    pub net_amount: u64,
    pub mint: Pubkey,
    pub daily_spent_before: u64,
    pub proof_timestamp: u64,
    pub job: Pubkey,
    pub stripe_receipt_hash: Signal,
}

fn integer(value: u64) -> Signal {
    let mut signal = [0; 32];
    signal[24..].copy_from_slice(&value.to_be_bytes());
    signal
}

/// Adresin 128 bitlik iki yarısı: `high` = 0..15. baytlar, `low` = 16..31. baytlar (big-endian).
fn halves(address: &Pubkey) -> (Signal, Signal) {
    let bytes = address.to_bytes();
    let mut high = [0; 32];
    let mut low = [0; 32];
    high[16..].copy_from_slice(&bytes[..16]);
    low[16..].copy_from_slice(&bytes[16..]);
    (high, low)
}

impl ReleaseSignals {
    /// `PUBLIC_SIGNALS` sırasıyla.
    pub fn public_inputs(&self) -> [Signal; RELEASE_NR_INPUTS] {
        let (payee_high, payee_low) = halves(&self.payee);
        let (mint_high, mint_low) = halves(&self.mint);
        let (job_high, job_low) = halves(&self.job);
        [
            integer(u64::from(self.refusal_code)),
            self.policy_commitment,
            integer(self.daily_ceiling),
            payee_high,
            payee_low,
            integer(self.net_amount),
            mint_high,
            mint_low,
            integer(self.daily_spent_before),
            integer(self.proof_timestamp),
            job_high,
            job_low,
            self.stripe_receipt_hash,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release_vk_vector::RELEASE_PUBLIC_INPUTS;

    #[test]
    fn integers_and_address_halves_are_big_endian_field_elements() {
        assert_eq!(integer(0x0102)[30..], [1, 2]);
        assert!(integer(u64::MAX)[..24].iter().all(|b| *b == 0));
        let address = Pubkey::new_from_array(core::array::from_fn(|i| i as u8));
        let (high, low) = halves(&address);
        assert_eq!(high[..16], [0; 16]);
        assert_eq!(high[16..], address.to_bytes()[..16]);
        assert_eq!(low[16..], address.to_bytes()[16..]);
    }

    /// Pipeline'ın gerçek ispatındaki sinyaller (release_vk_vector.rs) aynı kurallarla geri kurulur.
    #[test]
    fn rebuilds_the_signals_of_the_pipeline_vector() {
        let inputs = RELEASE_PUBLIC_INPUTS;
        let address = |high: &Signal, low: &Signal| {
            let mut bytes = [0; 32];
            bytes[..16].copy_from_slice(&high[16..]);
            bytes[16..].copy_from_slice(&low[16..]);
            Pubkey::new_from_array(bytes)
        };
        let int = |s: &Signal| u64::from_be_bytes(s[24..].try_into().unwrap());
        let rebuilt = ReleaseSignals {
            refusal_code: int(&inputs[0]) as u16,
            policy_commitment: inputs[1],
            daily_ceiling: int(&inputs[2]),
            payee: address(&inputs[3], &inputs[4]),
            net_amount: int(&inputs[5]),
            mint: address(&inputs[6], &inputs[7]),
            daily_spent_before: int(&inputs[8]),
            proof_timestamp: int(&inputs[9]),
            job: address(&inputs[10], &inputs[11]),
            stripe_receipt_hash: inputs[12],
        }
        .public_inputs();
        assert_eq!(rebuilt, inputs);
    }
}
