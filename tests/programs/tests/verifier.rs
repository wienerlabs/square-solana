//! square_verifier (henüz Aperture verifier'ının arayüzü; BC-21 sözleşmeye taşır): operatörün günlük
//! harcama durumu, ayarlanan saatte UTC gün başına bağlanır.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_signer::Signer;
use square_common::seeds::OPERATOR_STATE_SEED;
use square_common::time::day_start;
use square_program_tests::{cu, Harness};
use verifier::state::OperatorState;

fn initialize(h: &Harness, operator: &Pubkey) -> Instruction {
    Instruction {
        program_id: verifier::ID,
        accounts: verifier::accounts::InitializeOperatorState {
            operator_state: Pubkey::find_program_address(
                &[OPERATOR_STATE_SEED, operator.as_ref()],
                &verifier::ID,
            )
            .0,
            operator: *operator,
            payer: h.payer.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: verifier::instruction::InitializeOperatorState {}.data(),
    }
}

#[test]
fn anchors_the_daily_counter_to_the_utc_day_of_the_clock() {
    let mut h = Harness::new();
    h.deploy("verifier", verifier::ID);
    let operator = h.funded(1_000_000_000);

    // 2026-09-21 14:13:20 UTC; gün 2026-09-21 00:00:00 UTC'de başlar.
    h.set_time(1_790_000_000);
    let ix = initialize(&h, &operator.pubkey());
    let executed = h
        .send(&[ix], &[&operator])
        .expect("initialize_operator_state");
    cu::within("verifier.initialize_operator_state", &executed, 20_000);

    let address = Pubkey::find_program_address(
        &[OPERATOR_STATE_SEED, operator.pubkey().as_ref()],
        &verifier::ID,
    )
    .0;
    let state: OperatorState = h.account(&address).expect("OperatorState");
    assert_eq!(state.operator, operator.pubkey());
    assert_eq!(state.daily_spent_lamports, 0);
    assert_eq!(state.day_start_unix, day_start(1_790_000_000));
    assert_eq!(state.day_start_unix, 1_789_948_800);
}

#[test]
fn a_second_initialization_is_rejected() {
    let mut h = Harness::new();
    h.deploy("verifier", verifier::ID);
    let operator = h.funded(1_000_000_000);
    let ix = initialize(&h, &operator.pubkey());
    h.send(&[ix.clone()], &[&operator]).expect("ilk init");
    // Saat bir gün ilerlese de PDA zaten var: `init` ikinci kez çalışmaz.
    h.advance(86_400);
    let failed = h.send(&[ix], &[&operator]).expect_err("ikinci init");
    assert!(
        failed.logs.iter().any(|l| l.contains("already in use")),
        "{}",
        failed.logs.join("\n")
    );
}
