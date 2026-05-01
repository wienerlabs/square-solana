use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use policy_registry::state::PolicyAccount;
use crate::groth16_vk::{APERTURE_PAYMENT_VK, PAYMENT_NR_INPUTS};
use crate::state::{ProofRecord, ComplianceStatus, OperatorState};

/// Adım 5 — Sıkılaştırılmış verifier.
///
/// The v2 instruction now consumes ALL nine public inputs the Circom circuit
/// emits and cross-checks the meaningful ones against on-chain truth before
/// it accepts the proof:
///
///   public_inputs[0] = is_compliant            → must equal 1
///   public_inputs[1] = policy_data_hash        → must equal PolicyAccount.policy_data_hash
///                                                AND PolicyAccount.active && belongs to operator
///   public_inputs[2] = recipient_high          → checked by transfer-hook in Adım 6
///   public_inputs[3] = recipient_low           → checked by transfer-hook in Adım 6
///   public_inputs[4] = amount_lamports         → checked by transfer-hook in Adım 6
///   public_inputs[5] = token_mint_high         → checked by transfer-hook in Adım 6
///   public_inputs[6] = token_mint_low          → checked by transfer-hook in Adım 6
///   public_inputs[7] = daily_spent_before      → must equal effective on-chain daily spend
///   public_inputs[8] = current_unix_timestamp  → must be within ±60s of Solana clock
///
/// What this instruction guarantees once it succeeds:
///   * The proof is cryptographically sound (alt_bn128 pairing check passed).
///   * The policy the prover claimed is the EXACT policy registered on-chain
///     under that operator and is still active.
///   * The daily-spent value the circuit consumed matches what OperatorState
///     would surface today (with UTC midnight rollover).
///   * The timestamp the circuit consumed is fresh — no replay of yesterday's
///     proof against today's compliance window.
///
/// What still has to be enforced downstream (Adım 6):
///   * recipient/amount/mint match the actual SPL Token-2022 transfer that
///     the transfer-hook intercepts.
///   * daily_spent is incremented atomically as a side-effect of that transfer.
#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
)]
pub struct VerifyPaymentProofV2<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ProofRecord::INIT_SPACE,
        // Seed by the policy_data_hash (public_inputs[1]) — same hash the
        // dashboard's buildVerifyPaymentProofV2Ix uses on the client side.
        seeds = [b"proof", operator.key().as_ref(), &public_inputs[1]],
        bump,
    )]
    pub proof_record: Account<'info, ProofRecord>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ComplianceStatus::INIT_SPACE,
        seeds = [b"compliance", operator.key().as_ref()],
        bump,
    )]
    pub compliance_status: Account<'info, ComplianceStatus>,

    /// On-chain operator state used to derive `daily_spent_before`. Lazily
    /// created so callers do not have to invoke initialize_operator_state
    /// first; the seed binding makes spoofing impossible.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + OperatorState::INIT_SPACE,
        seeds = [b"operator_state", operator.key().as_ref()],
        bump,
    )]
    pub operator_state: Account<'info, OperatorState>,

    /// PolicyAccount written by the policy-registry program. The address is
    /// validated by Anchor against the policy-registry program ID via the
    /// `owner` constraint, the inner fields by the `constraint`s, and the
    /// commitment value by the public-input check in `handler`.
    #[account(
        owner = policy_registry::ID,
        constraint = policy_account.active @ VerifierV2Error::PolicyInactive,
        constraint = policy_account.operator == operator_account.key()
            @ VerifierV2Error::PolicyOperatorMismatch,
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    /// Operator's PolicyRegistry::OperatorAccount — used so the `policy_account`
    /// constraint above can pin the policy to a specific operator without
    /// hard-coding which signer-derived PDA they are using.
    #[account(
        owner = policy_registry::ID,
        constraint = operator_account.authority == operator.key()
            @ VerifierV2Error::PolicyOperatorMismatch,
    )]
    pub operator_account: Account<'info, policy_registry::state::OperatorAccount>,

    pub operator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Maximum drift we allow between the timestamp the circuit committed to and
/// Solana's Clock at verification time. Generous enough to absorb proof
/// generation + relay latency without opening a meaningful replay window.
const TIMESTAMP_TOLERANCE_SECONDS: i64 = 60;

/// Decodes a 32-byte big-endian BN254 field element into a u64. Returns an
/// error if any of the high 24 bytes are non-zero (i.e. the value would
/// overflow u64). Used to parse amount_lamports / daily_spent_before /
/// current_unix_timestamp from the proof's public inputs.
fn read_u64_from_field(bytes: &[u8; 32]) -> Result<u64> {
    for &b in &bytes[0..24] {
        if b != 0 {
            return err!(VerifierV2Error::PublicInputOverflow);
        }
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&bytes[24..32]);
    Ok(u64::from_be_bytes(buf))
}

/// Same as read_u64_from_field but signed. Field elements are non-negative,
/// so we still reject any high-bit set in the top 25 bytes; only timestamps
/// up to i64::MAX (~year 292277026596) fit, which is fine for a Clock value.
fn read_i64_from_field(bytes: &[u8; 32]) -> Result<i64> {
    let v = read_u64_from_field(bytes)?;
    if v > i64::MAX as u64 {
        return err!(VerifierV2Error::PublicInputOverflow);
    }
    Ok(v as i64)
}

pub fn handler(
    ctx: Context<VerifyPaymentProofV2>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
) -> Result<()> {
    // 1. Cryptographic Groth16 verification via alt_bn128 syscalls.
    let mut verifier = Groth16Verifier::<PAYMENT_NR_INPUTS>::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &APERTURE_PAYMENT_VK,
    )
    .map_err(|_| error!(VerifierV2Error::MalformedProof))?;

    verifier
        .verify()
        .map_err(|_| error!(VerifierV2Error::ProofVerificationFailed))?;

    // 2. is_compliant must be exactly 1. We only register compliant proofs;
    //    callers that want to record a violation should do so through a
    //    different code path (compliance dashboards, alerting), not by
    //    persisting a non-compliant ProofRecord.
    let is_compliant_bytes = public_inputs[0];
    let is_compliant_one = {
        let mut expected = [0u8; 32];
        expected[31] = 1;
        is_compliant_bytes == expected
    };
    if !is_compliant_one {
        return err!(VerifierV2Error::NotCompliant);
    }

    // 3. policy_data_hash byte-equality. PolicyAccount.policy_data_hash is
    //    written by policy-registry's register_policy / update_policy, which
    //    receive the value from the dashboard wallet flow that signed off the
    //    same Poseidon commitment the policy-service produced. If it differs
    //    here the prover is using stale or fabricated policy fields.
    let proof_policy_hash = public_inputs[1];
    if proof_policy_hash != ctx.accounts.policy_account.policy_data_hash {
        return err!(VerifierV2Error::PolicyHashMismatch);
    }

    // 4. daily_spent_before must reflect the operator's effective on-chain
    //    spend for the current UTC day. If the OperatorState carries a stale
    //    day_start_unix the effective spend is 0 (the next record_payment
    //    instruction will reset it); otherwise it is whatever is stored.
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let proof_daily_spent = read_u64_from_field(&public_inputs[7])?;
    let onchain_daily_spent = if ctx.accounts.operator_state.is_new_day(now) {
        0u64
    } else {
        ctx.accounts.operator_state.daily_spent_lamports
    };
    if proof_daily_spent != onchain_daily_spent {
        return err!(VerifierV2Error::DailySpentMismatch);
    }

    // 5. current_unix_timestamp drift check. Reject proofs that pre-date or
    //    post-date the validator's clock by more than the tolerance window.
    let proof_unix = read_i64_from_field(&public_inputs[8])?;
    let drift = (now - proof_unix).abs();
    if drift > TIMESTAMP_TOLERANCE_SECONDS {
        return err!(VerifierV2Error::TimestampOutOfRange);
    }

    // 5b. stripe_receipt_hash MUST be zero for the Solana flow. A non-zero
    //     value means the operator generated the proof for an MPP (Stripe)
    //     payment; that proof has to go through verify_mpp_payment_proof
    //     instead, which checks the compliance-api ed25519 attestation. If
    //     we accepted it here, the same Stripe receipt could be replayed
    //     against multiple Solana transfers — exactly the cross-flow
    //     escalation we are guarding against.
    if public_inputs[9] != [0u8; 32] {
        return err!(VerifierV2Error::StripeReceiptUnexpected);
    }

    // 6. Decode the transfer-binding fields from public_inputs[2..7]. Each
    //    BN254 field carries the high or low 16 bytes of a 32-byte pubkey
    //    (or a u64 amount). Reassemble them into the layout the transfer-hook
    //    will see when intercepting the SPL Token-2022 transfer.
    fn read_high_low_pubkey(
        high_field: &[u8; 32],
        low_field: &[u8; 32],
    ) -> Result<[u8; 32]> {
        // The high half lives in the bottom 16 bytes of the 32-byte BE field;
        // the top 16 bytes must be zero for the value to fit in 128 bits.
        for &b in &high_field[0..16] {
            if b != 0 {
                return err!(VerifierV2Error::PublicInputOverflow);
            }
        }
        for &b in &low_field[0..16] {
            if b != 0 {
                return err!(VerifierV2Error::PublicInputOverflow);
            }
        }
        let mut out = [0u8; 32];
        out[0..16].copy_from_slice(&high_field[16..32]);
        out[16..32].copy_from_slice(&low_field[16..32]);
        Ok(out)
    }
    let recipient = read_high_low_pubkey(&public_inputs[2], &public_inputs[3])?;
    let token_mint = read_high_low_pubkey(&public_inputs[5], &public_inputs[6])?;
    let amount_lamports = read_u64_from_field(&public_inputs[4])?;

    // 7. (Initialise OperatorState lazily.) When init_if_needed allocated the
    //    PDA above the discriminator/space were set, but the per-account
    //    fields are still zero. Backfill them now and stamp the pending
    //    proof hash so the transfer-hook can resolve the matching ProofRecord.
    {
        let state = &mut ctx.accounts.operator_state;
        if state.operator == Pubkey::default() {
            state.operator = ctx.accounts.operator.key();
            state.day_start_unix = OperatorState::day_start_for(now);
            state.bump = ctx.bumps.operator_state;
            // daily_spent_lamports and total_lifetime_payments remain 0.
        }
        // The pending slot must be free — refusing to overwrite catches the
        // case where the operator generated a second proof before the first
        // transfer landed; that scenario would let the operator front-run
        // their own daily-spend accounting.
        if state.pending_proof_hash != [0u8; 32]
            && state.pending_proof_hash != proof_policy_hash
        {
            return err!(VerifierV2Error::PendingProofAlreadySet);
        }
        state.pending_proof_hash = proof_policy_hash;
    }

    // 8. Persist proof record + compliance status snapshot.
    let proof = &mut ctx.accounts.proof_record;
    proof.operator = ctx.accounts.operator.key();
    proof.policy_id = ctx.accounts.policy_account.key().to_bytes();
    proof.proof_hash = proof_policy_hash;
    proof.image_id = [0u32; 8];
    proof.journal_digest = proof_policy_hash;
    proof.timestamp = now;
    proof.verified = true;
    proof.consumed = false;
    proof.recipient = recipient;
    proof.token_mint = token_mint;
    proof.amount_lamports = amount_lamports;
    proof.bump = ctx.bumps.proof_record;

    let status = &mut ctx.accounts.compliance_status;
    status.operator = ctx.accounts.operator.key();
    status.is_compliant = true;
    status.last_proof_hash = proof_policy_hash;
    status.last_verified_at = now;
    status.total_proofs = status.total_proofs.saturating_add(1);
    status.bump = ctx.bumps.compliance_status;

    msg!(
        "Payment proof v2 verified: operator={}, policy={}, daily_spent={}, total_proofs={}",
        ctx.accounts.operator.key(),
        ctx.accounts.policy_account.key(),
        onchain_daily_spent,
        status.total_proofs
    );
    Ok(())
}

#[error_code]
pub enum VerifierV2Error {
    #[msg("Groth16 proof is malformed or has invalid byte layout")]
    MalformedProof,
    #[msg("Groth16 proof verification failed on-chain")]
    ProofVerificationFailed,
    #[msg("Public input has an invalid canonical encoding")]
    MalformedPublicInput,
    #[msg("Public input overflows the expected u64/i64 bound")]
    PublicInputOverflow,
    #[msg("Proof claims a non-compliant outcome — only compliant proofs may be persisted")]
    NotCompliant,
    #[msg("Proof's policy_data_hash does not match the on-chain PolicyAccount commitment")]
    PolicyHashMismatch,
    #[msg("Policy is not active on-chain")]
    PolicyInactive,
    #[msg("Policy account is not registered to the signing operator")]
    PolicyOperatorMismatch,
    #[msg("Proof's daily_spent_before does not match OperatorState's effective daily spend")]
    DailySpentMismatch,
    #[msg("Proof timestamp drifted outside the allowed window from the Solana clock")]
    TimestampOutOfRange,
    #[msg("Operator already has a different pending proof — consume it via a transfer first")]
    PendingProofAlreadySet,
    #[msg("Proof carries a Stripe receipt hash; this Solana-flow instruction does not accept MPP proofs")]
    StripeReceiptUnexpected,
}
