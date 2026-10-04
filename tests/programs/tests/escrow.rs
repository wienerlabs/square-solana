//! square_escrow (henüz Covenant escrow'unun arayüzü; BC-22 sözleşmeye taşır): settlement mint'iyle
//! işin açılması, kabulü ve teslimi; challenge penceresi bitmeden finalize reddedilir, saat pencerenin
//! sonuna ilerletilince ödeme taker'a gider.

use anchor_lang::prelude::{Pubkey, Rent};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::SysvarId;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::seeds::{CLAIM_SEED, CONFIG_SEED, JOB_SEED, REPUTATION_SEED, VAULT_SEED};
use square_escrow::errors::CovError;
use square_escrow::state::{AgentReputation, JobEscrow, JobStatus, ProtocolConfig};
use square_program_tests::token::{self, TOKEN_PROGRAM_ID};
use square_program_tests::{anchor_error, cu, programdata_address, Harness};

const DAY: i64 = 86_400;
const AMOUNT: u64 = 250_000_000; // 250 USDC
const SPEC_HASH: [u8; 32] = [9; 32];

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &square_escrow::ID).0
}

struct Job {
    poster: Keypair,
    taker: Keypair,
    mint: Pubkey,
    job: Pubkey,
    vault: Pubkey,
    taker_ata: Pubkey,
}

/// Escrow yüklenir, config yükseltme yetkilisi tarafından kurulur, poster'a USDC basılır ve iş açılıp
/// kabul edilir.
fn open_and_accept(h: &mut Harness) -> Job {
    let admin = h.funded(10_000_000_000);
    h.deploy_upgradeable("square_escrow", square_escrow::ID, admin.pubkey());
    h.set_time(1_790_000_000);

    let config = pda(&[CONFIG_SEED]);
    let init_config = Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::InitConfig {
            admin: admin.pubkey(),
            config,
            program: square_escrow::ID,
            program_data: programdata_address(&square_escrow::ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_escrow::instruction::InitConfig {
            arbitrators: [
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                Pubkey::new_unique(),
            ],
            threshold: 2,
            min_challenge_period: 3_600,
            max_challenge_period: 7 * DAY as u64,
            min_bond_bps: 500,
            min_bond_absolute: 1_000_000,
        }
        .data(),
    };
    h.send(&[init_config], &[&admin]).expect("init_config");
    let stored: ProtocolConfig = h.account(&config).expect("ProtocolConfig");
    assert_eq!(stored.admin, admin.pubkey());

    let poster = h.funded(10_000_000_000);
    let taker = h.funded(10_000_000_000);
    let mint_authority = Keypair::new();
    let mint = token::create_usdc_mint(h, &mint_authority.pubkey());
    let poster_ata = token::create_ata(h, &poster.pubkey(), &mint);
    let taker_ata = token::create_ata(h, &taker.pubkey(), &mint);
    token::mint_to(h, &mint, &mint_authority, &poster_ata, AMOUNT);

    let job = pda(&[JOB_SEED, poster.pubkey().as_ref(), &SPEC_HASH]);
    let vault = pda(&[VAULT_SEED, job.as_ref()]);
    let create_job = Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::CreateJob {
            poster: poster.pubkey(),
            config,
            job_escrow: job,
            escrow_token_account: vault,
            poster_token_account: poster_ata,
            token_mint: mint,
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
            rent: Rent::id(),
        }
        .to_account_metas(None),
        data: square_escrow::instruction::CreateJob {
            amount: AMOUNT,
            spec_hash: SPEC_HASH,
            deadline: h.now() + 7 * DAY,
            challenge_period: DAY as u64,
        }
        .data(),
    };
    let executed = h.send(&[create_job], &[&poster]).expect("create_job");
    cu::within("escrow.create_job", &executed, 80_000);
    assert_eq!(token::balance(h, &vault), Some(AMOUNT));
    assert_eq!(token::balance(h, &poster_ata), Some(0));

    let accept = Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::AcceptJob {
            taker: taker.pubkey(),
            job_escrow: job,
            poster: poster.pubkey(),
        }
        .to_account_metas(None),
        data: square_escrow::instruction::AcceptJob {
            spec_hash: SPEC_HASH,
        }
        .data(),
    };
    h.send(&[accept], &[&taker]).expect("accept_job");

    Job {
        poster,
        taker,
        mint,
        job,
        vault,
        taker_ata,
    }
}

fn submit_work(h: &mut Harness, j: &Job) {
    let ix = Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::SubmitWork {
            taker: j.taker.pubkey(),
            job_escrow: j.job,
            poster: j.poster.pubkey(),
        }
        .to_account_metas(None),
        data: square_escrow::instruction::SubmitWork {
            work_hash: [3; 32],
            delivery_uri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
                .to_string(),
        }
        .data(),
    };
    h.send(&[ix], &[&j.taker]).expect("submit_work");
}

fn finalize(j: &Job, crank: &Keypair) -> Instruction {
    Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::FinalizePayment {
            crank: crank.pubkey(),
            job_escrow: j.job,
            poster: j.poster.pubkey(),
            escrow_token_account: j.vault,
            taker_token_account: j.taker_ata,
            taker: j.taker.pubkey(),
            taker_reputation: pda(&[REPUTATION_SEED, j.taker.pubkey().as_ref()]),
            claim_listing: pda(&[CLAIM_SEED, j.job.as_ref()]),
            token_mint: j.mint,
            token_program: TOKEN_PROGRAM_ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_escrow::instruction::FinalizePayment {}.data(),
    }
}

#[test]
fn pays_the_taker_only_after_the_challenge_window() {
    let mut h = Harness::new();
    let j = open_and_accept(&mut h);
    submit_work(&mut h, &j);
    let delivered: JobEscrow = h.account(&j.job).expect("JobEscrow");
    assert_eq!(delivered.status, JobStatus::Delivered);
    assert_eq!(delivered.challenge_end, h.now() + DAY);

    // Finalize herkese açıktır (crank); pencere bitmeden reddedilir.
    let crank = h.funded(1_000_000_000);
    let ix = finalize(&j, &crank);
    h.send(std::slice::from_ref(&ix), &[&crank])
        .expect_err("pencere bitmeden finalize")
        .assert_error(anchor_error(CovError::ChallengePeriodNotExpired));
    h.advance(DAY - 1);
    h.send(std::slice::from_ref(&ix), &[&crank])
        .expect_err("pencerenin son saniyesinde finalize")
        .assert_error(anchor_error(CovError::ChallengePeriodNotExpired));

    // Pencerenin sonu: ödeme taker'a, iş hesabı kapanır, itibar taker'a yazılır.
    h.advance(1);
    let executed = h.send(&[ix], &[&crank]).expect("finalize_payment");
    cu::within("escrow.finalize_payment", &executed, 80_000);
    assert_eq!(token::balance(&h, &j.taker_ata), Some(AMOUNT));
    assert_eq!(token::balance(&h, &j.vault), None);
    assert!(h.account::<JobEscrow>(&j.job).is_none());
    let reputation: AgentReputation = h
        .account(&pda(&[REPUTATION_SEED, j.taker.pubkey().as_ref()]))
        .expect("AgentReputation");
    assert_eq!(reputation.jobs_completed, 1);
}

#[test]
fn only_the_upgrade_authority_initializes_the_config() {
    let mut h = Harness::new();
    let admin = h.funded(1_000_000_000);
    let intruder = h.funded(1_000_000_000);
    h.deploy_upgradeable("square_escrow", square_escrow::ID, admin.pubkey());
    let ix = Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::InitConfig {
            admin: intruder.pubkey(),
            config: pda(&[CONFIG_SEED]),
            program: square_escrow::ID,
            program_data: programdata_address(&square_escrow::ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_escrow::instruction::InitConfig {
            arbitrators: [
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                Pubkey::new_unique(),
            ],
            threshold: 2,
            min_challenge_period: 3_600,
            max_challenge_period: 7 * DAY as u64,
            min_bond_bps: 500,
            min_bond_absolute: 1_000_000,
        }
        .data(),
    };
    h.send(&[ix], &[&intruder])
        .expect_err("yetkisiz init_config")
        .assert_error(anchor_error(CovError::Unauthorized));
}
