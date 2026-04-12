use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeRestriction {
    pub allowed_days: Vec<String>,
    pub allowed_hours_start: u8,
    pub allowed_hours_end: u8,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProverInput {
    pub policy_id: String,
    pub operator_id: String,
    pub max_daily_spend_lamports: u64,
    pub max_per_transaction_lamports: u64,
    pub allowed_endpoint_categories: Vec<String>,
    pub blocked_addresses: Vec<String>,
    pub time_restrictions: Vec<TimeRestriction>,
    pub token_whitelist: Vec<String>,
    pub payment_amount_lamports: u64,
    pub payment_token_mint: String,
    pub payment_recipient: String,
    pub payment_endpoint_category: String,
    pub payment_timestamp: String,
    pub daily_spent_so_far_lamports: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProverOutput {
    pub is_compliant: bool,
    pub proof_hash: String,
    pub amount_range_min: u64,
    pub amount_range_max: u64,
    pub verification_timestamp: String,
    pub journal_digest: String,
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

pub fn compute_proof_hash(input: &ProverInput) -> String {
    let serialized = serde_json::to_string(input).expect("Failed to serialize ProverInput");
    sha256_hex(serialized.as_bytes())
}

pub fn compute_amount_range(amount_lamports: u64, bucket_size: u64) -> (u64, u64) {
    let min = (amount_lamports / bucket_size) * bucket_size;
    let max = min + bucket_size;
    (min, max)
}

pub fn compute_journal_digest(
    is_compliant: bool,
    proof_hash: &str,
    amount_range_min: u64,
    amount_range_max: u64,
    verification_timestamp: &str,
) -> String {
    let data = format!(
        "{}:{}:{}:{}:{}",
        is_compliant, proof_hash, amount_range_min, amount_range_max, verification_timestamp
    );
    sha256_hex(data.as_bytes())
}

pub fn verify_compliance(input: &ProverInput) -> (bool, String) {
    // Check 1: per-transaction limit
    if input.payment_amount_lamports > input.max_per_transaction_lamports {
        return (false, "Exceeds per-transaction limit".to_string());
    }

    // Check 2: daily spending limit
    if input.daily_spent_so_far_lamports + input.payment_amount_lamports
        > input.max_daily_spend_lamports
    {
        return (false, "Exceeds daily spend limit".to_string());
    }

    // Check 3: token whitelist
    if !input.token_whitelist.contains(&input.payment_token_mint) {
        return (false, "Token not in whitelist".to_string());
    }

    // Check 4: blocked addresses (sanctions)
    if input.blocked_addresses.contains(&input.payment_recipient) {
        return (false, "Recipient is on blocked list".to_string());
    }

    // Check 5: endpoint category
    if !input
        .allowed_endpoint_categories
        .contains(&input.payment_endpoint_category)
    {
        return (false, "Endpoint category not allowed".to_string());
    }

    (true, String::new())
}

pub const AMOUNT_BUCKET_SIZE: u64 = 1_000_000; // 1 USDC/USDT (6 decimals)

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> ProverInput {
        ProverInput {
            policy_id: "policy-1".to_string(),
            operator_id: "operator-1".to_string(),
            max_daily_spend_lamports: 100_000_000,
            max_per_transaction_lamports: 10_000_000,
            allowed_endpoint_categories: vec!["compute".to_string(), "storage".to_string()],
            blocked_addresses: vec!["BlockedAddr111".to_string()],
            time_restrictions: vec![],
            token_whitelist: vec!["USDCmint111".to_string()],
            payment_amount_lamports: 5_000_000,
            payment_token_mint: "USDCmint111".to_string(),
            payment_recipient: "Recipient111".to_string(),
            payment_endpoint_category: "compute".to_string(),
            payment_timestamp: "2026-04-01T12:00:00Z".to_string(),
            daily_spent_so_far_lamports: 50_000_000,
        }
    }

    #[test]
    fn test_compliant_payment() {
        let (compliant, reason) = verify_compliance(&sample_input());
        assert!(compliant);
        assert!(reason.is_empty());
    }

    #[test]
    fn test_exceeds_per_tx_limit() {
        let mut input = sample_input();
        input.payment_amount_lamports = 20_000_000;
        let (compliant, _) = verify_compliance(&input);
        assert!(!compliant);
    }

    #[test]
    fn test_exceeds_daily_limit() {
        let mut input = sample_input();
        input.daily_spent_so_far_lamports = 96_000_000;
        let (compliant, _) = verify_compliance(&input);
        assert!(!compliant);
    }

    #[test]
    fn test_blocked_address() {
        let mut input = sample_input();
        input.payment_recipient = "BlockedAddr111".to_string();
        let (compliant, _) = verify_compliance(&input);
        assert!(!compliant);
    }

    #[test]
    fn test_wrong_token() {
        let mut input = sample_input();
        input.payment_token_mint = "InvalidMint".to_string();
        let (compliant, _) = verify_compliance(&input);
        assert!(!compliant);
    }

    #[test]
    fn test_wrong_category() {
        let mut input = sample_input();
        input.payment_endpoint_category = "gambling".to_string();
        let (compliant, _) = verify_compliance(&input);
        assert!(!compliant);
    }

    #[test]
    fn test_amount_bucketing() {
        let (min, max) = compute_amount_range(1_500_000, AMOUNT_BUCKET_SIZE);
        assert_eq!(min, 1_000_000);
        assert_eq!(max, 2_000_000);
    }
}
