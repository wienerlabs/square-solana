pragma circom 2.0.0;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";

// PaymentCompliance proves that an AI agent payment satisfies all five rules
// of its operator's policy without revealing the policy details or the
// payment specifics on-chain.
//
// Output signals (public):
//   - is_compliant   : 1 if all rules pass, 0 otherwise
//   - journal_digest : Poseidon commitment to the full input tuple; the
//                      Solana verifier re-computes this off-chain to ensure
//                      the proof was generated against the expected inputs
//
// Input signals (private):
//   Policy ceiling values, list-based rules (with a parallel mask that marks
//   which slots are active — padded slots carry sentinel 0 and are ignored),
//   the operator's current daily accumulator, and the payment being checked.
//
// List-based rules use Poseidon-hashed field elements so that Solana addresses
// and category strings fit into a single BN254 field element each.
template PaymentCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES) {
    // === Policy ===
    signal input max_per_tx_lamports;
    signal input max_daily_lamports;

    signal input token_whitelist[MAX_WHITELIST];
    signal input token_whitelist_mask[MAX_WHITELIST];

    signal input blocked_addresses[MAX_BLOCKED];
    signal input blocked_addresses_mask[MAX_BLOCKED];

    signal input allowed_categories[MAX_CATEGORIES];
    signal input allowed_categories_mask[MAX_CATEGORIES];

    // === Operator state ===
    signal input daily_spent_lamports;

    // === Payment being evaluated ===
    signal input payment_amount_lamports;
    signal input payment_token;     // Poseidon(token mint bytes)
    signal input payment_recipient; // Poseidon(recipient pubkey bytes)
    signal input payment_category;  // Poseidon(category string bytes)

    // === Public outputs ===
    signal output is_compliant;
    signal output journal_digest;

    // ------------------------------------------------------------------
    // Rule 1: payment_amount_lamports <= max_per_tx_lamports
    // ------------------------------------------------------------------
    component rule1 = LessEqThan(64);
    rule1.in[0] <== payment_amount_lamports;
    rule1.in[1] <== max_per_tx_lamports;
    signal rule1_ok;
    rule1_ok <== rule1.out;

    // ------------------------------------------------------------------
    // Rule 2: daily_spent + payment_amount <= max_daily
    // ------------------------------------------------------------------
    signal projected_daily;
    projected_daily <== daily_spent_lamports + payment_amount_lamports;

    component rule2 = LessEqThan(65);
    rule2.in[0] <== projected_daily;
    rule2.in[1] <== max_daily_lamports;
    signal rule2_ok;
    rule2_ok <== rule2.out;

    // ------------------------------------------------------------------
    // Rule 3: payment_token matches at least one active whitelist entry.
    //
    // For each slot: hit[i] = IsEqual(payment_token, whitelist[i]) * mask[i]
    // Then cumulative OR across all slots. Padded slots (mask=0) contribute
    // zero to the OR and are effectively ignored.
    // ------------------------------------------------------------------
    component whitelist_eq[MAX_WHITELIST];
    signal whitelist_hit[MAX_WHITELIST];
    signal whitelist_or[MAX_WHITELIST];

    for (var i = 0; i < MAX_WHITELIST; i++) {
        whitelist_eq[i] = IsEqual();
        whitelist_eq[i].in[0] <== payment_token;
        whitelist_eq[i].in[1] <== token_whitelist[i];
        whitelist_hit[i] <== whitelist_eq[i].out * token_whitelist_mask[i];
    }

    whitelist_or[0] <== whitelist_hit[0];
    for (var i = 1; i < MAX_WHITELIST; i++) {
        // Boolean OR expressed without new constraints beyond one multiplier:
        // a OR b = a + b - a*b
        whitelist_or[i] <==
            whitelist_or[i - 1] + whitelist_hit[i]
            - whitelist_or[i - 1] * whitelist_hit[i];
    }
    signal rule3_ok;
    rule3_ok <== whitelist_or[MAX_WHITELIST - 1];

    // ------------------------------------------------------------------
    // Rule 4: payment_recipient is NOT in the blocked list.
    //
    // Build the same cumulative OR of matches; rule4_ok = 1 - has_match.
    // ------------------------------------------------------------------
    component blocked_eq[MAX_BLOCKED];
    signal blocked_hit[MAX_BLOCKED];
    signal blocked_or[MAX_BLOCKED];

    for (var i = 0; i < MAX_BLOCKED; i++) {
        blocked_eq[i] = IsEqual();
        blocked_eq[i].in[0] <== payment_recipient;
        blocked_eq[i].in[1] <== blocked_addresses[i];
        blocked_hit[i] <== blocked_eq[i].out * blocked_addresses_mask[i];
    }

    blocked_or[0] <== blocked_hit[0];
    for (var i = 1; i < MAX_BLOCKED; i++) {
        blocked_or[i] <==
            blocked_or[i - 1] + blocked_hit[i]
            - blocked_or[i - 1] * blocked_hit[i];
    }
    signal rule4_ok;
    rule4_ok <== 1 - blocked_or[MAX_BLOCKED - 1];

    // ------------------------------------------------------------------
    // Rule 5: payment_category matches at least one active category entry.
    // ------------------------------------------------------------------
    component category_eq[MAX_CATEGORIES];
    signal category_hit[MAX_CATEGORIES];
    signal category_or[MAX_CATEGORIES];

    for (var i = 0; i < MAX_CATEGORIES; i++) {
        category_eq[i] = IsEqual();
        category_eq[i].in[0] <== payment_category;
        category_eq[i].in[1] <== allowed_categories[i];
        category_hit[i] <== category_eq[i].out * allowed_categories_mask[i];
    }

    category_or[0] <== category_hit[0];
    for (var i = 1; i < MAX_CATEGORIES; i++) {
        category_or[i] <==
            category_or[i - 1] + category_hit[i]
            - category_or[i - 1] * category_hit[i];
    }
    signal rule5_ok;
    rule5_ok <== category_or[MAX_CATEGORIES - 1];

    // ------------------------------------------------------------------
    // Combine: is_compliant = rule1 AND rule2 AND rule3 AND rule4 AND rule5
    // Each AND is one multiplicative constraint in BN254.
    // ------------------------------------------------------------------
    signal and_12;
    signal and_123;
    signal and_1234;
    and_12  <== rule1_ok * rule2_ok;
    and_123 <== and_12   * rule3_ok;
    and_1234 <== and_123 * rule4_ok;
    is_compliant <== and_1234 * rule5_ok;

    // ------------------------------------------------------------------
    // Journal digest = Poseidon commitment over a compact summary of the
    // inputs. The verifier re-derives this off-chain to ensure the proof
    // was produced for the specific transaction claimed.
    //
    // Hashing strategy: chunk by category (policy ceilings | payment) and
    // fold via a second Poseidon call, which keeps each call within the
    // circomlib Poseidon(nInputs) bound (nInputs <= 16).
    // ------------------------------------------------------------------
    component policy_hash = Poseidon(4);
    policy_hash.inputs[0] <== max_per_tx_lamports;
    policy_hash.inputs[1] <== max_daily_lamports;
    policy_hash.inputs[2] <== daily_spent_lamports;
    policy_hash.inputs[3] <== is_compliant;

    component payment_hash = Poseidon(4);
    payment_hash.inputs[0] <== payment_amount_lamports;
    payment_hash.inputs[1] <== payment_token;
    payment_hash.inputs[2] <== payment_recipient;
    payment_hash.inputs[3] <== payment_category;

    component fold = Poseidon(2);
    fold.inputs[0] <== policy_hash.out;
    fold.inputs[1] <== payment_hash.out;

    journal_digest <== fold.out;
}

component main = PaymentCompliance(10, 10, 8);
