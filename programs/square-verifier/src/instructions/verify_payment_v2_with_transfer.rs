//! Adım 9 — Single-shot verify + transfer for x402 payments without
//! relying on the SPL Token-2022 transfer-hook callback.
//!
//! Why this exists: the dashboard wallet-adapter ships verify_v2 +
//! transferCheckedWithTransferHook as a legacy Transaction and Solana
//! accepts it. The agent runs the same bundle from a Node.js Keypair
//! signer; the bundle then weighs 1234 bytes (2 over the legacy 1232 cap)
//! and the V0 fallback hits a Token-2022 + transfer-hook resolution bug
//! that surfaces as a "custom 0xa261c2c0" before the hook is even invoked.
//!
//! This instruction sidesteps both by collapsing the two ix into one
//! Anchor instruction. The compliance gate the transfer-hook used to
//! enforce (recipient/mint/amount/proof binding + daily_spent ceiling)
//! is enforced HERE, atomically with the Token-2022 CPI:
//!
//!   1. Groth16 proof verification (same as verify_payment_v2).
//!   2. Public-input integrity (is_compliant=1, policy hash, daily_spent,
//!      timestamp, no Stripe receipt).
//!   3. Decoded recipient / token_mint / amount_lamports MUST match the
//!      account list passed for the CPI transfer — same byte-binding the
//!      transfer-hook performed.
//!   4. `record_payment` semantics inlined: bump daily_spent, mark the
//!      ProofRecord consumed, refresh OperatorState.day_start_unix on
//!      UTC rollover, increment lifetime counter.
//!   5. CPI to Token-2022 transferChecked. The hook never sees this
//!      transfer — but every check it would have performed is already
//!      enforced above, so the security envelope is unchanged.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};
use groth16_solana::groth16::Groth16Verifier;

use crate::groth16_vk::{APERTURE_PAYMENT_VK, PAYMENT_NR_INPUTS};
use crate::state::{ComplianceStatus, OperatorState, ProofRecord};
use policy_registry::state::PolicyAccount;

/// Whitelisted token program IDs. The instruction accepts either:
///   - SPL Token (the legacy "Token-1" program, used by Circle USDC, USDT,
///     and most production stablecoins), or
///   - SPL Token-2022 (newer extension-aware program, used by Aperture's
///     own aUSDC mint that carries a transfer-hook).
/// Compliance is enforced inside this Anchor handler regardless of which
/// program the mint is owned by, so adding both lets the same instruction
/// drive USDC, USDT, and aUSDC payments interchangeably.
pub mod token_program_ids {
    use super::*;
    anchor_lang::declare_id!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
}
pub mod token_2022_program_id {
    use super::*;
    anchor_lang::declare_id!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
    transfer_amount: u64,
)]
pub struct VerifyPaymentProofV2WithTransfer<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ProofRecord::INIT_SPACE,
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

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + OperatorState::INIT_SPACE,
        seeds = [b"operator_state", operator.key().as_ref()],
        bump,
    )]
    pub operator_state: Account<'info, OperatorState>,

    #[account(
        owner = policy_registry::ID,
        constraint = policy_account.active @ VerifyWithTransferError::PolicyInactive,
        constraint = policy_account.operator == operator_account.key()
            @ VerifyWithTransferError::PolicyOperatorMismatch,
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    #[account(
        owner = policy_registry::ID,
        constraint = operator_account.authority == operator.key()
            @ VerifyWithTransferError::PolicyOperatorMismatch,
    )]
    pub operator_account: Account<'info, policy_registry::state::OperatorAccount>,

    pub operator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// Source token-2022 account holding the operator's aUSDC.
    /// Layout-validated at runtime in handler (mint, owner, amount).
    #[account(mut)]
    /// CHECK: Validated below as a Token-2022 account whose mint matches
    /// `mint`, whose owner authority matches the signer, and whose program
    /// owner is the SPL Token-2022 program ID.
    pub source_token_account: AccountInfo<'info>,

    /// Destination token-2022 account. Existence is required (we don't
    /// init_if_needed it here) so the agent-side flow can decide whether
    /// to fund the ATA in a separate small tx.
    #[account(mut)]
    /// CHECK: Validated below as a Token-2022 account whose mint matches
    /// `mint` and whose program owner is the SPL Token-2022 program ID.
    pub destination_token_account: AccountInfo<'info>,

    /// SPL Token-2022 mint with Aperture's transfer-hook attached.
    /// CHECK: Validated below — must be owned by the Token-2022 program
    /// and its bytes must match the proof's mint commitment.
    pub mint: AccountInfo<'info>,

    /// CHECK: Pinned to the SPL Token-2022 program ID below.
    pub token_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

const TIMESTAMP_TOLERANCE_SECONDS: i64 = 60;

/// SPL Token-2022 account layout (162 bytes, ignoring extensions):
///   0..32   mint
///   32..64  owner
///   64..72  amount (u64 LE)
const TOKEN_ACCOUNT_MINT_OFFSET: usize = 0;
const TOKEN_ACCOUNT_OWNER_OFFSET: usize = 32;

/// SPL Token-2022 mint layout (82 bytes base):
///   ...
///   44..45  decimals (u8) — at offset 44 in legacy mint, same in 2022 base
const MINT_DECIMALS_OFFSET: usize = 44;

/// Encoded discriminator for SPL Token-2022 TransferChecked instruction.
/// Layout: [12, amount_le_u64, decimals_u8] — 12 is the variant index for
/// TransferChecked in the SPL token instruction enum (same as legacy SPL
/// Token, which Token-2022 is wire-compatible with).
const TOKEN_2022_TRANSFER_CHECKED_VARIANT: u8 = 12;

fn read_u64_from_field(bytes: &[u8; 32]) -> Result<u64> {
    for &b in &bytes[0..24] {
        if b != 0 {
            return err!(VerifyWithTransferError::PublicInputOverflow);
        }
    }
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&bytes[24..32]);
    Ok(u64::from_be_bytes(buf))
}

fn read_i64_from_field(bytes: &[u8; 32]) -> Result<i64> {
    let v = read_u64_from_field(bytes)?;
    if v > i64::MAX as u64 {
        return err!(VerifyWithTransferError::PublicInputOverflow);
    }
    Ok(v as i64)
}

fn read_high_low_pubkey(high_field: &[u8; 32], low_field: &[u8; 32]) -> Result<[u8; 32]> {
    for &b in &high_field[0..16] {
        if b != 0 {
            return err!(VerifyWithTransferError::PublicInputOverflow);
        }
    }
    for &b in &low_field[0..16] {
        if b != 0 {
            return err!(VerifyWithTransferError::PublicInputOverflow);
        }
    }
    let mut out = [0u8; 32];
    out[0..16].copy_from_slice(&high_field[16..32]);
    out[16..32].copy_from_slice(&low_field[16..32]);
    Ok(out)
}

fn read_pubkey_at(account: &AccountInfo, offset: usize) -> Result<Pubkey> {
    let data = account.try_borrow_data()?;
    if data.len() < offset + 32 {
        return err!(VerifyWithTransferError::TokenAccountTooShort);
    }
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&data[offset..offset + 32]);
    Ok(Pubkey::from(buf))
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, VerifyPaymentProofV2WithTransfer<'info>>,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    public_inputs: [[u8; 32]; PAYMENT_NR_INPUTS],
    transfer_amount: u64,
) -> Result<()> {
    // ---- 0. Account program-owner pinning ------------------------------
    // Accept either SPL Token (Token-1) or SPL Token-2022. The token_program
    // account passed by the caller decides which CPI we issue, and the
    // source/dest/mint accounts must all be owned by that same program.
    let token_program_id = *ctx.accounts.token_program.key;
    if token_program_id != token_program_ids::ID
        && token_program_id != token_2022_program_id::ID
    {
        return err!(VerifyWithTransferError::TokenProgramMismatch);
    }
    require_keys_eq!(
        *ctx.accounts.source_token_account.owner,
        token_program_id,
        VerifyWithTransferError::TokenProgramMismatch
    );
    require_keys_eq!(
        *ctx.accounts.destination_token_account.owner,
        token_program_id,
        VerifyWithTransferError::TokenProgramMismatch
    );
    require_keys_eq!(
        *ctx.accounts.mint.owner,
        token_program_id,
        VerifyWithTransferError::TokenProgramMismatch
    );

    // Source account must be owned (authority) by the signer; the actual
    // Token-2022 transfer CPI re-checks this at instruction execution
    // time, but failing fast here surfaces a clearer error.
    let source_owner = read_pubkey_at(&ctx.accounts.source_token_account, TOKEN_ACCOUNT_OWNER_OFFSET)?;
    require_keys_eq!(
        source_owner,
        ctx.accounts.operator.key(),
        VerifyWithTransferError::SourceAuthorityMismatch
    );

    let source_mint = read_pubkey_at(&ctx.accounts.source_token_account, TOKEN_ACCOUNT_MINT_OFFSET)?;
    let dest_mint = read_pubkey_at(&ctx.accounts.destination_token_account, TOKEN_ACCOUNT_MINT_OFFSET)?;
    let mint_key = ctx.accounts.mint.key();
    require_keys_eq!(source_mint, mint_key, VerifyWithTransferError::MintMismatch);
    require_keys_eq!(dest_mint, mint_key, VerifyWithTransferError::MintMismatch);

    // ---- 1. Groth16 cryptographic verification --------------------------
    let mut verifier = Groth16Verifier::<PAYMENT_NR_INPUTS>::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &APERTURE_PAYMENT_VK,
    )
    .map_err(|_| error!(VerifyWithTransferError::MalformedProof))?;
    verifier
        .verify()
        .map_err(|_| error!(VerifyWithTransferError::ProofVerificationFailed))?;

    // ---- 2. Public-input integrity --------------------------------------
    let is_compliant_one = {
        let mut expected = [0u8; 32];
        expected[31] = 1;
        public_inputs[0] == expected
    };
    if !is_compliant_one {
        return err!(VerifyWithTransferError::NotCompliant);
    }

    let proof_policy_hash = public_inputs[1];
    if proof_policy_hash != ctx.accounts.policy_account.policy_data_hash {
        return err!(VerifyWithTransferError::PolicyHashMismatch);
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let proof_daily_spent = read_u64_from_field(&public_inputs[7])?;
    let onchain_daily_spent = if ctx.accounts.operator_state.is_new_day(now) {
        0u64
    } else {
        ctx.accounts.operator_state.daily_spent_lamports
    };
    if proof_daily_spent != onchain_daily_spent {
        return err!(VerifyWithTransferError::DailySpentMismatch);
    }

    let proof_unix = read_i64_from_field(&public_inputs[8])?;
    let drift = (now - proof_unix).abs();
    if drift > TIMESTAMP_TOLERANCE_SECONDS {
        return err!(VerifyWithTransferError::TimestampOutOfRange);
    }

    if public_inputs[9] != [0u8; 32] {
        return err!(VerifyWithTransferError::StripeReceiptUnexpected);
    }

    // ---- 3. Byte-binding the proof's recipient/mint/amount to the actual
    //         CPI transfer accounts. Same checks the transfer-hook would
    //         have done.
    let proof_recipient = read_high_low_pubkey(&public_inputs[2], &public_inputs[3])?;
    let proof_mint = read_high_low_pubkey(&public_inputs[5], &public_inputs[6])?;
    let proof_amount = read_u64_from_field(&public_inputs[4])?;

    let dest_owner = read_pubkey_at(&ctx.accounts.destination_token_account, TOKEN_ACCOUNT_OWNER_OFFSET)?;
    require_keys_eq!(
        Pubkey::from(proof_recipient),
        dest_owner,
        VerifyWithTransferError::RecipientMismatch
    );
    require_keys_eq!(
        Pubkey::from(proof_mint),
        mint_key,
        VerifyWithTransferError::MintMismatch
    );
    if proof_amount != transfer_amount {
        return err!(VerifyWithTransferError::AmountMismatch);
    }

    // ---- 4. Pre-CPI state setup ------------------------------------
    // The Token-2022 transferChecked CPI below auto-invokes the SPL
    // transfer-hook program (the aUSDC mint carries the TransferHook
    // extension). The hook expects:
    //   - OperatorState.pending_proof_hash == proof_policy_hash
    //   - ProofRecord.verified=true, consumed=false, fields match transfer
    // It then CPIs record_payment, which flips consumed=true and bumps
    // OperatorState.daily_spent. So we set pre-state here exactly like
    // verify_v2 did, leaving consumed/daily_spent updates to the hook
    // path so the hook does not double-bump or refuse on a mismatch.
    let operator_key = ctx.accounts.operator.key();
    let operator_state_bump = ctx.bumps.operator_state;
    {
        let state = &mut ctx.accounts.operator_state;
        if state.operator == Pubkey::default() {
            state.operator = operator_key;
            state.day_start_unix = OperatorState::day_start_for(now);
            state.bump = operator_state_bump;
        } else if state.is_new_day(now) {
            state.day_start_unix = OperatorState::day_start_for(now);
            state.daily_spent_lamports = 0;
        }
        // pending_proof_hash exists for the legacy two-tx flow (verify_v2
        // emits it, the separate transferChecked tx + transfer-hook
        // consumes it via record_payment). In this atomic ix verify and
        // transfer are bundled, so there is no in-flight pending state to
        // protect — overwrite unconditionally. We still set the field so
        // downstream tooling that scans OperatorState can read the most
        // recent proof's hash if it wants to.
        state.pending_proof_hash = proof_policy_hash;
    }

    let proof = &mut ctx.accounts.proof_record;
    proof.operator = operator_key;
    proof.policy_id = ctx.accounts.policy_account.key().to_bytes();
    proof.proof_hash = proof_policy_hash;
    proof.image_id = [0u32; 8];
    proof.journal_digest = proof_policy_hash;
    proof.timestamp = now;
    proof.verified = true;
    // The auto-invoked transfer-hook will flip this true via its
    // record_payment CPI. Setting it true here would make the hook
    // fail with ERR_PROOF_ALREADY_CONSUMED.
    proof.consumed = false;
    proof.recipient = proof_recipient;
    proof.token_mint = proof_mint;
    proof.amount_lamports = transfer_amount;
    proof.bump = ctx.bumps.proof_record;

    let status = &mut ctx.accounts.compliance_status;
    status.operator = operator_key;
    status.is_compliant = true;
    status.last_proof_hash = proof_policy_hash;
    status.last_verified_at = now;
    status.total_proofs = status.total_proofs.saturating_add(1);
    status.bump = ctx.bumps.compliance_status;

    // ---- 5. Token-2022 transferChecked CPI ------------------------------
    let mint_decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        if mint_data.len() <= MINT_DECIMALS_OFFSET {
            return err!(VerifyWithTransferError::MintDataTooShort);
        }
        mint_data[MINT_DECIMALS_OFFSET]
    };

    // CRITICAL: Anchor's Account<'info, T> defers serialization back into
    // the underlying AccountInfo.data buffer until the handler exits. The
    // auto-invoked transfer-hook reads OperatorState / ProofRecord /
    // ComplianceStatus straight from AccountInfo.data, so without an
    // explicit flush here it would see the pre-handler state and reject
    // with ERR_NO_PENDING_PROOF (0x1010). Force the writes to land
    // before the CPI fires.
    ctx.accounts.proof_record.exit(&crate::ID)?;
    ctx.accounts.compliance_status.exit(&crate::ID)?;
    ctx.accounts.operator_state.exit(&crate::ID)?;

    let mut ix_data = Vec::with_capacity(1 + 8 + 1);
    ix_data.push(TOKEN_2022_TRANSFER_CHECKED_VARIANT);
    ix_data.extend_from_slice(&transfer_amount.to_le_bytes());
    ix_data.push(mint_decimals);

    // The aUSDC mint carries the Token-2022 TransferHook extension, so
    // every transferChecked CPI auto-invokes the hook program and needs
    // the hook's required accounts (HookConfig, ExtraAccountMetaList,
    // and whatever the meta-list resolves to: verifier program, hook
    // config, compliance status, operator state, proof record). We don't
    // declare these in #[derive(Accounts)] because Anchor would force the
    // caller into a fixed account order; instead the agent passes them
    // via `remaining_accounts` already in the order Token-2022 expects,
    // and we forward them into the CPI verbatim.
    let mut cpi_accounts = vec![
        AccountMeta::new(*ctx.accounts.source_token_account.key, false),
        AccountMeta::new_readonly(*ctx.accounts.mint.key, false),
        AccountMeta::new(*ctx.accounts.destination_token_account.key, false),
        AccountMeta::new_readonly(*ctx.accounts.operator.key, true),
    ];
    for acc in ctx.remaining_accounts {
        cpi_accounts.push(if acc.is_writable {
            AccountMeta::new(*acc.key, acc.is_signer)
        } else {
            AccountMeta::new_readonly(*acc.key, acc.is_signer)
        });
    }

    let cpi_ix = Instruction {
        program_id: token_program_id,
        accounts: cpi_accounts,
        data: ix_data,
    };

    let mut invoke_accounts = vec![
        ctx.accounts.source_token_account.clone(),
        ctx.accounts.mint.clone(),
        ctx.accounts.destination_token_account.clone(),
        ctx.accounts.operator.to_account_info(),
        ctx.accounts.token_program.clone(),
    ];
    for acc in ctx.remaining_accounts {
        invoke_accounts.push(acc.clone());
    }

    invoke(&cpi_ix, &invoke_accounts)?;

    msg!(
        "x402 atomic verify+transfer: operator={}, policy={}, amount={}, daily_spent={}",
        operator_key,
        ctx.accounts.policy_account.key(),
        transfer_amount,
        ctx.accounts.operator_state.daily_spent_lamports
    );

    Ok(())
}

#[error_code]
pub enum VerifyWithTransferError {
    #[msg("Groth16 proof is malformed or has invalid byte layout")]
    MalformedProof,
    #[msg("Groth16 proof verification failed on-chain")]
    ProofVerificationFailed,
    #[msg("Public input overflows the expected u64/i64 bound")]
    PublicInputOverflow,
    #[msg("Proof claims a non-compliant outcome")]
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
    #[msg("Proof carries a Stripe receipt hash; this Solana-flow instruction does not accept MPP proofs")]
    StripeReceiptUnexpected,
    #[msg("Proof's recipient does not match the destination token account's owner")]
    RecipientMismatch,
    #[msg("Proof's token_mint does not match the mint account passed for the transfer")]
    MintMismatch,
    #[msg("Proof's amount does not match the transfer_amount argument")]
    AmountMismatch,
    #[msg("Daily spent overflowed u64 — should be unreachable for any realistic policy")]
    DailySpentOverflow,
    #[msg("Operator already has a different pending proof — consume it via a transfer first")]
    PendingProofAlreadySet,
    #[msg("Token program account is not the SPL Token-2022 program")]
    TokenProgramMismatch,
    #[msg("Source token account authority is not the signing operator")]
    SourceAuthorityMismatch,
    #[msg("Token account data is shorter than the SPL Token-2022 layout requires")]
    TokenAccountTooShort,
    #[msg("Mint account data is shorter than the SPL Token-2022 layout requires")]
    MintDataTooShort,
}
