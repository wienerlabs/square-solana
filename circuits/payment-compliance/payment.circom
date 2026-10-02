pragma circom 2.0.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";
include "./lib/timestamp.circom";

// ReleaseCompliance proves what a Square escrow release owes its institution's
// policy: whether the release fits every rule of the committed mandate, and
// exactly which rules it breaks when it does not. The proof is bound to one
// release — one job, one payee, one net amount, one mint, one day's counter and
// one moment — so the verifier (BC-21) can store it as that job's ReleaseProof
// and the escrow (BC-24) can act on it without trusting whoever built it.
//
// The normative description, including what the verifier must check against
// each signal, is docs/design/release-circuit.md. This header is the summary.
//
// ORIGIN
//
// Imported from Aperture's payment-prover (BC-06, docs/provenance/BC-06.md) and
// adapted under BC-19. The soundness fixes Arc (wienerlabs/square at dc0157f)
// made to the same circuit are carried over, because every one of them applies
// here unchanged:
//
//   1. The timestamp decomposition was under-constrained, so a prover could
//      choose the weekday. lib/timestamp.circom is the sound version.
//   2. The list mask arrays are gone. The commitment covered the list values
//      but not the masks, so zeroing blocked_addresses_mask switched rule 4 off
//      with a byte-identical commitment. Padding is zero and every lookup key is
//      constrained non-zero, so a padding slot can never match.
//   3. Every comparator operand is range-checked. circomlib's comparators bound
//      the difference of their operands, never the operands themselves.
//   4. The policy commitment is salted per field (square#45), so publishing
//      one value, or guessing an easy one, does not open the others.
//
// What BC-19 adds on top: the payee instead of the transfer recipient, the net
// amount, the job binding, the public daily ceiling as a rule of its own, and a
// refusal code in place of the is_compliant bit.
//
// PUBLIC SIGNALS, IN ORDER (13)
//
// A Solana address is 32 bytes and does not fit in one BN254 element, so it is
// carried as two 128-bit halves: high = bytes 0..15, low = bytes 16..31, each
// read big-endian. Each half is range-checked to 128 bits here, so a pair is
// always the canonical split of exactly one address.
//
//   [0]  refusal_code            0 when the release complies; otherwise one bit
//                                per broken rule (table below)
//   [1]  policy_commitment       salted Poseidon commitment to the whole policy
//   [2]  daily_ceiling           the policy's public daily ceiling (BC-17)
//   [3]  payee_high              address the release pays: the agent wallet, or
//   [4]  payee_low               the claim buyer when the receivable was sold
//   [5]  net_amount              what the payee receives, settlement-mint units
//   [6]  mint_high               settlement mint
//   [7]  mint_low
//   [8]  daily_spent_before      the institution's OperatorState counter
//   [9]  current_unix_timestamp  seconds; the verifier bounds it to Clock
//   [10] job_high                the escrow Job account this release belongs to
//   [11] job_low
//   [12] stripe_receipt_hash     Poseidon receipt commitment, 0 when unused
//
// REFUSAL CODE BITS
//
//   bit  value  rule broken
//   0    1      per-transaction ceiling: net_amount > max_per_tx
//   1    2      private daily ceiling: daily_spent_before + net_amount > max_daily
//   2    4      mint not on the token whitelist
//   3    8      payee on the blocked list
//   4    16     payment category not allowed
//   5    32     outside the policy's time window
//   6    64     public daily ceiling: daily_spent_before + net_amount > daily_ceiling
//
// A refusing proof is a valid proof. It is the institution's mandate deciding
// against this release, and it carries every rule that decided so.
//
// WHAT STAYS PRIVATE
//
//   - The two private ceilings (max_per_tx, max_daily).
//   - The whitelist, blocked list and category list.
//   - The payment category and the time window.
//   - The eight salts, and the operator and policy identifiers.
//
// Rule 5 binds nobody: payment_category is neither a public signal nor bound to
// anything on chain, so a prover can make rule 5 pass or fail at will. See
// docs/design/release-circuit.md before treating a category refusal as final.
template ReleaseCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES) {
    // ============================================================ Policy (private)
    signal input max_per_tx;
    signal input max_daily;

    // List entries are field elements produced by the caller:
    //   token_whitelist[i]   = Poseidon(mint_high, mint_low) of an allowed mint
    //   blocked_addresses[i] = Poseidon(high, low) of a blocked wallet
    //   allowed_categories[i], payment_category = Poseidon(high, low) of the
    //   category string's UTF-8 bytes zero-padded to 32
    // Slots 0..count-1 carry real entries and the rest are zero.
    signal input token_whitelist[MAX_WHITELIST];
    signal input blocked_addresses[MAX_BLOCKED];
    signal input allowed_categories[MAX_CATEGORIES];
    signal input payment_category;

    // Fields the commitment covers that never leak through a public signal.
    signal input operator_id_field;
    signal input policy_id_field;

    // One salt per committed field. Unconstrained on purpose: their only job is
    // entropy, and what pins them is the commitment itself, which the verifier
    // compares with the job's policy snapshot.
    signal input policy_salts[8];

    // Time restriction. time_active = 0 means no time gate. The three fields
    // below are range-checked whatever time_active is, so send 0 for all three
    // when there is no window.
    signal input time_active;
    signal input time_days_bitmask;
    signal input time_start_hour_utc;
    signal input time_end_hour_utc;

    // ============================================================ Release (public)
    // Mirrored to the public outputs below. The verifier fills every one of
    // them from accounts it reads, except net_amount, the timestamp and the
    // receipt hash, so a proof built for any other release fails the pairing.
    signal input daily_ceiling_in;
    signal input payee_high_in;
    signal input payee_low_in;
    signal input net_amount_in;
    signal input mint_high_in;
    signal input mint_low_in;
    signal input daily_spent_before_in;
    signal input current_unix_timestamp_in;
    signal input job_high_in;
    signal input job_low_in;

    // Stripe receipt commitment (MPP path, BC-37). Zero on the escrow release
    // path. Mirrored and not constrained further: Stripe is the trust root on
    // that path and the verifier checks the attestation signature.
    signal input stripe_receipt_hash_in;

    // ============================================================ Public outputs
    signal output refusal_code;
    signal output policy_commitment;
    signal output daily_ceiling;
    signal output payee_high;
    signal output payee_low;
    signal output net_amount;
    signal output mint_high;
    signal output mint_low;
    signal output daily_spent_before;
    signal output current_unix_timestamp;
    signal output job_high;
    signal output job_low;
    signal output stripe_receipt_hash;

    daily_ceiling <== daily_ceiling_in;
    payee_high <== payee_high_in;
    payee_low <== payee_low_in;
    net_amount <== net_amount_in;
    mint_high <== mint_high_in;
    mint_low <== mint_low_in;
    daily_spent_before <== daily_spent_before_in;
    current_unix_timestamp <== current_unix_timestamp_in;
    job_high <== job_high_in;
    job_low <== job_low_in;
    stripe_receipt_hash <== stripe_receipt_hash_in;

    // ============================================================ Amount bounds
    // Every operand of the three amount comparators is a u64 on chain, and is
    // constrained to be one here: a comparator bounds the difference of its
    // operands, so an unbounded operand near the modulus would make it answer
    // about a different value than the one it appears to compare.
    component net_amount_bits = Num2Bits(64);
    net_amount_bits.in <== net_amount;

    component daily_spent_bits = Num2Bits(64);
    daily_spent_bits.in <== daily_spent_before;

    component daily_ceiling_bits = Num2Bits(64);
    daily_ceiling_bits.in <== daily_ceiling;

    component max_per_tx_bits = Num2Bits(64);
    max_per_tx_bits.in <== max_per_tx;

    component max_daily_bits = Num2Bits(64);
    max_daily_bits.in <== max_daily;

    // ============================================================ Address halves
    // Each half under 2^128, so (high, low) is the canonical split of one
    // 32-byte address and no other pair names the same key.
    component payee_high_bits = Num2Bits(128);
    payee_high_bits.in <== payee_high;
    component payee_low_bits = Num2Bits(128);
    payee_low_bits.in <== payee_low;
    component mint_high_bits = Num2Bits(128);
    mint_high_bits.in <== mint_high;
    component mint_low_bits = Num2Bits(128);
    mint_low_bits.in <== mint_low;
    component job_high_bits = Num2Bits(128);
    job_high_bits.in <== job_high;
    component job_low_bits = Num2Bits(128);
    job_low_bits.in <== job_low;

    // ============================================================ Lookup keys
    // The list entries are Poseidon images of addresses, so the keys looked up
    // are too. All three keys are constrained non-zero, because zero is what
    // padding slots hold: that is what lets the mask arrays go.
    component payee_hasher = Poseidon(2);
    payee_hasher.inputs[0] <== payee_high;
    payee_hasher.inputs[1] <== payee_low;
    signal payee_key;
    payee_key <== payee_hasher.out;

    component mint_hasher = Poseidon(2);
    mint_hasher.inputs[0] <== mint_high;
    mint_hasher.inputs[1] <== mint_low;
    signal mint_key;
    mint_key <== mint_hasher.out;

    component payee_key_is_zero = IsZero();
    payee_key_is_zero.in <== payee_key;
    payee_key_is_zero.out === 0;

    component mint_key_is_zero = IsZero();
    mint_key_is_zero.in <== mint_key;
    mint_key_is_zero.out === 0;

    component category_is_zero = IsZero();
    category_is_zero.in <== payment_category;
    category_is_zero.out === 0;

    // ============================================================ Window bounds
    // hour is constrained to 0..23 by UtcDayHourChecked; these put the policy's
    // own bounds in range so the comparison cannot be steered by a field
    // element near the modulus.
    component start_hour_bits = Num2Bits(5);
    start_hour_bits.in <== time_start_hour_utc;

    component end_hour_bits = Num2Bits(5);
    end_hour_bits.in <== time_end_hour_utc;

    // time_active gates rule 6 through `1 - time_active + time_active * x`,
    // which only behaves like a switch for a boolean.
    time_active * (time_active - 1) === 0;

    // ============================================================ Rule 1
    // net_amount <= max_per_tx
    component rule1 = LessEqThan(64);
    rule1.in[0] <== net_amount;
    rule1.in[1] <== max_per_tx;
    signal rule1_ok;
    rule1_ok <== rule1.out;

    // ============================================================ Rule 2
    // daily_spent_before + net_amount <= max_daily (private ceiling)
    signal projected_daily;
    projected_daily <== daily_spent_before + net_amount;
    component rule2 = LessEqThan(65);
    rule2.in[0] <== projected_daily;
    rule2.in[1] <== max_daily;
    signal rule2_ok;
    rule2_ok <== rule2.out;

    // ============================================================ Rule 3
    // mint_key matches a whitelist entry.
    component whitelist_eq[MAX_WHITELIST];
    signal whitelist_or[MAX_WHITELIST];
    for (var i = 0; i < MAX_WHITELIST; i++) {
        whitelist_eq[i] = IsEqual();
        whitelist_eq[i].in[0] <== mint_key;
        whitelist_eq[i].in[1] <== token_whitelist[i];
    }
    whitelist_or[0] <== whitelist_eq[0].out;
    for (var i = 1; i < MAX_WHITELIST; i++) {
        whitelist_or[i] <==
            whitelist_or[i - 1] + whitelist_eq[i].out
            - whitelist_or[i - 1] * whitelist_eq[i].out;
    }
    signal rule3_ok;
    rule3_ok <== whitelist_or[MAX_WHITELIST - 1];

    // ============================================================ Rule 4
    // payee_key is NOT in the blocked list.
    component blocked_eq[MAX_BLOCKED];
    signal blocked_or[MAX_BLOCKED];
    for (var i = 0; i < MAX_BLOCKED; i++) {
        blocked_eq[i] = IsEqual();
        blocked_eq[i].in[0] <== payee_key;
        blocked_eq[i].in[1] <== blocked_addresses[i];
    }
    blocked_or[0] <== blocked_eq[0].out;
    for (var i = 1; i < MAX_BLOCKED; i++) {
        blocked_or[i] <==
            blocked_or[i - 1] + blocked_eq[i].out
            - blocked_or[i - 1] * blocked_eq[i].out;
    }
    signal rule4_ok;
    rule4_ok <== 1 - blocked_or[MAX_BLOCKED - 1];

    // ============================================================ Rule 5
    // payment_category matches an allowed_categories entry.
    component category_eq[MAX_CATEGORIES];
    signal category_or[MAX_CATEGORIES];
    for (var i = 0; i < MAX_CATEGORIES; i++) {
        category_eq[i] = IsEqual();
        category_eq[i].in[0] <== payment_category;
        category_eq[i].in[1] <== allowed_categories[i];
    }
    category_or[0] <== category_eq[0].out;
    for (var i = 1; i < MAX_CATEGORIES; i++) {
        category_or[i] <==
            category_or[i - 1] + category_eq[i].out
            - category_or[i - 1] * category_eq[i].out;
    }
    signal rule5_ok;
    rule5_ok <== category_or[MAX_CATEGORIES - 1];

    // ============================================================ Rule 6
    // current_unix_timestamp falls inside the policy's window when one is
    // configured; a free pass when time_active == 0. The decomposition is
    // witnessed here and constrained in UtcDayHourChecked.
    component clock = UtcDayHourChecked(40);
    clock.timestamp <== current_unix_timestamp;
    clock.day_index <-- current_unix_timestamp \ 86400;
    clock.sec_in_day <-- current_unix_timestamp % 86400;
    clock.hour <-- (current_unix_timestamp % 86400) \ 3600;
    clock.sec_in_hour <-- (current_unix_timestamp % 86400) % 3600;
    clock.weeks <-- ((current_unix_timestamp \ 86400) + 3) \ 7;
    clock.day_of_week <-- ((current_unix_timestamp \ 86400) + 3) % 7;

    signal hour;
    signal day_of_week;
    hour <== clock.hour_out;
    day_of_week <== clock.day_of_week_out;

    // Decompose days_bitmask (bit 0 = Monday) into 7 bits so it can be indexed
    // by day_of_week. The accumulator equality forces the unique decomposition
    // and the mask under 128.
    signal day_bits[7];
    signal day_bits_acc[8];
    day_bits_acc[0] <== 0;
    for (var i = 0; i < 7; i++) {
        day_bits[i] <-- (time_days_bitmask >> i) & 1;
        day_bits[i] * (day_bits[i] - 1) === 0;
        day_bits_acc[i + 1] <== day_bits_acc[i] + day_bits[i] * (1 << i);
    }
    day_bits_acc[7] === time_days_bitmask;

    // Select day_bits[day_of_week]; day_of_week is 0..6, so exactly one term
    // can be non-zero.
    component dow_eq[7];
    signal day_active_terms[7];
    signal day_active_acc[8];
    day_active_acc[0] <== 0;
    for (var i = 0; i < 7; i++) {
        dow_eq[i] = IsEqual();
        dow_eq[i].in[0] <== day_of_week;
        dow_eq[i].in[1] <== i;
        day_active_terms[i] <== dow_eq[i].out * day_bits[i];
        day_active_acc[i + 1] <== day_active_acc[i] + day_active_terms[i];
    }
    signal day_active;
    day_active <== day_active_acc[7];

    // hour_in_window = (hour >= start) AND (hour <= end). Assumes start <= end:
    // a window that runs past midnight is not modelled, and under one no hour
    // is inside the window. Policy tooling must refuse start > end.
    component hour_ge_start = GreaterEqThan(8);
    hour_ge_start.in[0] <== hour;
    hour_ge_start.in[1] <== time_start_hour_utc;

    component hour_le_end = LessEqThan(8);
    hour_le_end.in[0] <== hour;
    hour_le_end.in[1] <== time_end_hour_utc;

    signal hour_in_window;
    hour_in_window <== hour_ge_start.out * hour_le_end.out;

    signal time_compliant_when_active;
    time_compliant_when_active <== day_active * hour_in_window;
    signal rule6_ok;
    rule6_ok <== 1 - time_active + time_active * time_compliant_when_active;

    // ============================================================ Rule 7
    // daily_spent_before + net_amount <= daily_ceiling (public ceiling, BC-17).
    // The chain can check this one itself; it is in the circuit so the proof's
    // verdict never disagrees with that check, and a release the public ceiling
    // stops is a refusal with its own reason rather than a proof that verifies
    // and a release that cannot happen.
    component rule7 = LessEqThan(65);
    rule7.in[0] <== projected_daily;
    rule7.in[1] <== daily_ceiling;
    signal rule7_ok;
    rule7_ok <== rule7.out;

    // ============================================================ Refusal code
    // Every rule_ok above is boolean, so this is the unique bitmask of broken
    // rules and 0 exactly when all seven pass.
    refusal_code <==
          (1 - rule1_ok)
        + (1 - rule2_ok) * 2
        + (1 - rule3_ok) * 4
        + (1 - rule4_ok) * 8
        + (1 - rule5_ok) * 16
        + (1 - rule6_ok) * 32
        + (1 - rule7_ok) * 64;

    // ============================================================ Policy commitment
    // Must stay byte-identical to the policy tooling's commitment.
    //
    //   value[0] = max_daily
    //   value[1] = max_per_tx
    //   value[2] = operator_id_field
    //   value[3] = policy_id_field
    //   value[4] = Poseidon(allowed_categories)  padded to MAX_CATEGORIES
    //   value[5] = Poseidon(blocked_addresses)   padded to MAX_BLOCKED
    //   value[6] = Poseidon(token_whitelist)     padded to MAX_WHITELIST
    //   value[7] = time_field: 0 with no window, otherwise
    //              Poseidon(1, days_bitmask, start_hour, end_hour)
    //
    //   leaf[i]    = Poseidon(3)(i, policy_salts[i], value[i])
    //   commitment = Poseidon(8)(leaf[0] .. leaf[7])
    //
    // The index inside each leaf keeps a leaf from being replayed in another
    // position, and a leaf (Poseidon(3)) cannot pass for the root (Poseidon(8)).
    // Disclosing (i, value[i], salt[i]) and the seven sibling leaves opens one
    // field without opening the others.
    component cat_list_hash = Poseidon(MAX_CATEGORIES);
    for (var i = 0; i < MAX_CATEGORIES; i++) {
        cat_list_hash.inputs[i] <== allowed_categories[i];
    }

    component blocked_list_hash = Poseidon(MAX_BLOCKED);
    for (var i = 0; i < MAX_BLOCKED; i++) {
        blocked_list_hash.inputs[i] <== blocked_addresses[i];
    }

    component tokens_list_hash = Poseidon(MAX_WHITELIST);
    for (var i = 0; i < MAX_WHITELIST; i++) {
        tokens_list_hash.inputs[i] <== token_whitelist[i];
    }

    // Computed unconditionally and muxed to 0 when the restriction is off.
    component time_when_active = Poseidon(4);
    time_when_active.inputs[0] <== time_active;
    time_when_active.inputs[1] <== time_days_bitmask;
    time_when_active.inputs[2] <== time_start_hour_utc;
    time_when_active.inputs[3] <== time_end_hour_utc;
    signal time_field;
    time_field <== time_active * time_when_active.out;

    signal policy_values[8];
    policy_values[0] <== max_daily;
    policy_values[1] <== max_per_tx;
    policy_values[2] <== operator_id_field;
    policy_values[3] <== policy_id_field;
    policy_values[4] <== cat_list_hash.out;
    policy_values[5] <== blocked_list_hash.out;
    policy_values[6] <== tokens_list_hash.out;
    policy_values[7] <== time_field;

    component policy_leaf[8];
    component policy_hasher = Poseidon(8);
    for (var i = 0; i < 8; i++) {
        policy_leaf[i] = Poseidon(3);
        policy_leaf[i].inputs[0] <== i;
        policy_leaf[i].inputs[1] <== policy_salts[i];
        policy_leaf[i].inputs[2] <== policy_values[i];
        policy_hasher.inputs[i] <== policy_leaf[i].out;
    }
    policy_commitment <== policy_hasher.out;
}

// MAX_WHITELIST = 10, MAX_BLOCKED = 10, MAX_CATEGORIES = 8. These, the public
// signal order and the refusal bits are frozen by the trusted setup (BC-20,
// BC-38): changing any of them needs a new proving key and a new verifying key
// in square_verifier.
component main = ReleaseCompliance(10, 10, 8);
