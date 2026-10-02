pragma circom 2.0.0;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";

// PaymentCompliance proves that an AI-agent payment satisfies all six rules
// of its operator's policy AND binds the proof to a specific transfer.
//
// Compared to the v1 circuit (private payment fields, only is_compliant +
// journal_digest exposed) this version exposes the transfer parameters
// (recipient, amount, mint, timestamp) and the policy commitment as PUBLIC
// outputs so the on-chain verifier can:
//
//   1. cross-check the proof's recipient_high/low against the actual transfer
//      instruction's destination ATA (Adım 5),
//   2. cross-check token_mint_high/low against the transfer's mint,
//   3. cross-check amount_lamports against the transfer's amount,
//   4. cross-check daily_spent_before against the on-chain OperatorState PDA
//      (Adım 3 + Adım 6),
//   5. cross-check current_unix_timestamp against Solana's Clock sysvar,
//   6. cross-check policy_data_hash against PolicyAccount.policy_data_hash
//      written by the policy-registry program (Adım 2).
//
// Anything still private:
//   - The policy ceiling values (max_per_tx, max_daily) — operators reveal
//     only that the payment fit, not what their cap was.
//   - The whitelist / blocked / category lists — auditors learn membership
//     was checked but not what the lists contained.
//   - The payment category — auditors do not learn what kind of service
//     the agent paid for.
//
// Hash algorithms:
//   - Inside-circuit: Poseidon (cheap, BN254-native).
//   - Backend services/policy-service/src/utils/merkle.ts MUST produce the
//     same Poseidon commitments byte-for-byte (Adım 4a).
template PaymentCompliance(MAX_WHITELIST, MAX_BLOCKED, MAX_CATEGORIES) {
    // ============================================================ Policy (private)
    signal input max_per_tx_lamports;
    signal input max_daily_lamports;

    // Lists are pre-hashed (each entry is a single BN254 field element) by
    // the prover-service before being fed in. Slot 0..count-1 carries real
    // entries; the rest are 0-padded and the parallel mask marks active slots.
    signal input token_whitelist[MAX_WHITELIST];
    signal input token_whitelist_mask[MAX_WHITELIST];
    signal input blocked_addresses[MAX_BLOCKED];
    signal input blocked_addresses_mask[MAX_BLOCKED];
    signal input allowed_categories[MAX_CATEGORIES];
    signal input allowed_categories_mask[MAX_CATEGORIES];

    // Service-layer fields the policy_data_hash commits to but that never
    // leak through any public output.
    signal input payment_category;
    signal input operator_id_field;
    signal input policy_id_field;

    // Time restriction config. time_active=0 means "no time gate"; in that
    // case the rest of the time fields are free witnesses ignored by the
    // hash and the rule.
    signal input time_active;
    signal input time_days_bitmask;
    signal input time_start_hour_utc;
    signal input time_end_hour_utc;

    // ============================================================ Payment (public)
    // These signals are wired straight to public outputs at the bottom so the
    // on-chain verifier can read them out of the proof. The prover MUST set
    // them to the same values the actual Solana transfer uses; otherwise
    // rules 3/4 still pass against the wrong target and the verifier will
    // reject in Adım 5 because they no longer match the transfer instruction.
    signal input recipient_high_in;
    signal input recipient_low_in;
    signal input amount_lamports_in;
    signal input token_mint_high_in;
    signal input token_mint_low_in;
    signal input daily_spent_before_in;
    signal input current_unix_timestamp_in;

    // Stripe (MPP B-flow) receipt commitment. Zero when the proof is for a
    // pure Solana payment (no Stripe involved); a non-zero Poseidon hash
    // when the operator paid via Stripe and is claiming the matching
    // PaymentIntent. The on-chain verifier (Adım 8c) ed25519-checks this
    // value against the compliance-api's MPP authority signature; the
    // circuit itself does not constrain it cryptographically beyond
    // mirroring it to a public output, because Stripe is the trust root.
    signal input stripe_receipt_hash_in;

    // ============================================================ Public outputs
    signal output is_compliant;
    signal output policy_data_hash;
    signal output recipient_high;
    signal output recipient_low;
    signal output amount_lamports;
    signal output token_mint_high;
    signal output token_mint_low;
    signal output daily_spent_before;
    signal output current_unix_timestamp;
    signal output stripe_receipt_hash;

    // Mirror inputs to outputs. With Groth16 over BN254 this just reuses the
    // signal — no extra constraint cost beyond the equality.
    recipient_high <== recipient_high_in;
    recipient_low <== recipient_low_in;
    amount_lamports <== amount_lamports_in;
    token_mint_high <== token_mint_high_in;
    token_mint_low <== token_mint_low_in;
    daily_spent_before <== daily_spent_before_in;
    current_unix_timestamp <== current_unix_timestamp_in;
    stripe_receipt_hash <== stripe_receipt_hash_in;

    // ============================================================ Hashed payment fields
    // payment_token = Poseidon([token_mint_high, token_mint_low]) — same
    // shape services/prover-service/src/hash.js uses for hashSolanaAddress,
    // so a whitelist entry produced from the same pubkey collides exactly.
    component token_hasher = Poseidon(2);
    token_hasher.inputs[0] <== token_mint_high;
    token_hasher.inputs[1] <== token_mint_low;
    signal payment_token;
    payment_token <== token_hasher.out;

    component recipient_hasher = Poseidon(2);
    recipient_hasher.inputs[0] <== recipient_high;
    recipient_hasher.inputs[1] <== recipient_low;
    signal payment_recipient;
    payment_recipient <== recipient_hasher.out;

    // ============================================================ Rule 1
    // amount_lamports <= max_per_tx_lamports
    component rule1 = LessEqThan(64);
    rule1.in[0] <== amount_lamports;
    rule1.in[1] <== max_per_tx_lamports;
    signal rule1_ok;
    rule1_ok <== rule1.out;

    // ============================================================ Rule 2
    // daily_spent_before + amount_lamports <= max_daily_lamports
    signal projected_daily;
    projected_daily <== daily_spent_before + amount_lamports;
    component rule2 = LessEqThan(65);
    rule2.in[0] <== projected_daily;
    rule2.in[1] <== max_daily_lamports;
    signal rule2_ok;
    rule2_ok <== rule2.out;

    // ============================================================ Rule 3
    // payment_token matches at least one active whitelist entry.
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
        whitelist_or[i] <==
            whitelist_or[i - 1] + whitelist_hit[i]
            - whitelist_or[i - 1] * whitelist_hit[i];
    }
    signal rule3_ok;
    rule3_ok <== whitelist_or[MAX_WHITELIST - 1];

    // ============================================================ Rule 4
    // payment_recipient is NOT in the blocked list.
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

    // ============================================================ Rule 5
    // payment_category matches an active allowed_categories entry.
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

    // ============================================================ Rule 6 (NEW)
    // current_unix_timestamp falls inside the policy's allowed window when
    // a window is configured. When time_active == 0 this rule is a free pass.
    //
    // Step 1: derive day_index and sec_in_day from the timestamp via a
    // witnessed division pattern, with both parts range-checked so the
    // prover cannot cheat by witnessing arbitrary values.
    signal day_index;
    signal sec_in_day;
    day_index <-- current_unix_timestamp \ 86400;
    sec_in_day <-- current_unix_timestamp - day_index * 86400;
    day_index * 86400 + sec_in_day === current_unix_timestamp;

    component lt_sec_in_day = LessThan(20);
    lt_sec_in_day.in[0] <== sec_in_day;
    lt_sec_in_day.in[1] <== 86400;
    lt_sec_in_day.out === 1;

    // Step 2: hour = floor(sec_in_day / 3600), 0..23
    signal hour;
    signal sec_in_hour;
    hour <-- sec_in_day \ 3600;
    sec_in_hour <-- sec_in_day - hour * 3600;
    hour * 3600 + sec_in_hour === sec_in_day;

    component lt_sec_in_hour = LessThan(15);
    lt_sec_in_hour.in[0] <== sec_in_hour;
    lt_sec_in_hour.in[1] <== 3600;
    lt_sec_in_hour.out === 1;

    component lt_hour = LessThan(5);
    lt_hour.in[0] <== hour;
    lt_hour.in[1] <== 24;
    lt_hour.out === 1;

    // Step 3: day_of_week = (day_index + 4) mod 7
    // 1970-01-01 was a Thursday; with Mon=0, Thu=3, so the offset is +3, but
    // ISO weekday constants used by the dashboard map Mon=0..Sun=6, and
    // 1970-01-01 -> Thursday -> 3, hence the +3 shift here.
    signal day_of_week;
    signal weeks;
    weeks <-- (day_index + 3) \ 7;
    day_of_week <-- (day_index + 3) - weeks * 7;
    weeks * 7 + day_of_week === day_index + 3;

    component lt_dow = LessThan(4);
    lt_dow.in[0] <== day_of_week;
    lt_dow.in[1] <== 7;
    lt_dow.out === 1;

    // Step 4: decompose days_bitmask into 7 bit signals so we can index
    // it by day_of_week.
    signal day_bits[7];
    signal day_bits_acc[8];
    day_bits_acc[0] <== 0;
    for (var i = 0; i < 7; i++) {
        day_bits[i] <-- (time_days_bitmask >> i) & 1;
        day_bits[i] * (day_bits[i] - 1) === 0;
        day_bits_acc[i + 1] <== day_bits_acc[i] + day_bits[i] * (1 << i);
    }
    day_bits_acc[7] === time_days_bitmask;

    // Step 5: select day_bits[day_of_week] using IsEqual + sum.
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

    // Step 6: hour_in_window = (hour >= start) AND (hour <= end). MVP
    // assumes start <= end; midnight-spanning windows (e.g. 22-06) will be
    // handled in a future revision once the dashboard models them.
    component hour_ge_start = GreaterEqThan(8);
    hour_ge_start.in[0] <== hour;
    hour_ge_start.in[1] <== time_start_hour_utc;

    component hour_le_end = LessEqThan(8);
    hour_le_end.in[0] <== hour;
    hour_le_end.in[1] <== time_end_hour_utc;

    signal hour_in_window;
    hour_in_window <== hour_ge_start.out * hour_le_end.out;

    // Step 7: combine. When time_active == 0 the rule is a free pass.
    // rule6_ok = (1 - time_active) + time_active * (day_active * hour_in_window)
    signal time_compliant_when_active;
    time_compliant_when_active <== day_active * hour_in_window;
    signal rule6_ok;
    rule6_ok <== 1 - time_active + time_active * time_compliant_when_active;

    // ============================================================ Combine all rules
    signal and_12;
    signal and_123;
    signal and_1234;
    signal and_12345;
    and_12 <== rule1_ok * rule2_ok;
    and_123 <== and_12 * rule3_ok;
    and_1234 <== and_123 * rule4_ok;
    and_12345 <== and_1234 * rule5_ok;
    is_compliant <== and_12345 * rule6_ok;

    // ============================================================ policy_data_hash
    // MUST stay byte-for-byte identical to
    // services/policy-service/src/utils/merkle.ts::computePolicyDataHash.
    //
    // Backend layout:
    //   poseidon([
    //     max_daily,
    //     max_per_tx,
    //     operator_field,
    //     policy_id_field,
    //     poseidon(categories_padded_to_8),
    //     poseidon(blocked_padded_to_10),
    //     poseidon(tokens_padded_to_10),
    //     time_field
    //   ])
    // where time_field is 0 when no restriction is configured, otherwise
    // poseidon([1, days_bitmask, start_hour, end_hour]).
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

    // Compute Poseidon over the time fields unconditionally; mux to 0 when
    // time_active == 0 so the result lines up with the backend's "0 sentinel
    // for empty restrictions" rule.
    component time_when_active = Poseidon(4);
    time_when_active.inputs[0] <== time_active;
    time_when_active.inputs[1] <== time_days_bitmask;
    time_when_active.inputs[2] <== time_start_hour_utc;
    time_when_active.inputs[3] <== time_end_hour_utc;
    signal time_field;
    time_field <== time_active * time_when_active.out;

    component policy_hasher = Poseidon(8);
    policy_hasher.inputs[0] <== max_daily_lamports;
    policy_hasher.inputs[1] <== max_per_tx_lamports;
    policy_hasher.inputs[2] <== operator_id_field;
    policy_hasher.inputs[3] <== policy_id_field;
    policy_hasher.inputs[4] <== cat_list_hash.out;
    policy_hasher.inputs[5] <== blocked_list_hash.out;
    policy_hasher.inputs[6] <== tokens_list_hash.out;
    policy_hasher.inputs[7] <== time_field;
    policy_data_hash <== policy_hasher.out;
}

// MAX_WHITELIST = 10, MAX_BLOCKED = 10, MAX_CATEGORIES = 8 — must match
// the constants in services/policy-service/src/utils/merkle.ts and
// services/prover-service/src/prover.js. Changing any of these is a
// breaking circuit change that requires re-running the trusted setup and
// updating the on-chain verifying key.
component main = PaymentCompliance(10, 10, 8);
