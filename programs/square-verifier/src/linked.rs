//! Policy ve escrow hesaplarını CPI'sız okuma (program arayüzü §4). Owner, `VerifierConfig`'teki program
//! kimliğidir; PDA adresi kaydın kendi seed alanları ve bump'ıyla yeniden türetilir. Owner, adres ya da
//! veri uymazsa `InvalidLinkedAccount`.

use anchor_lang::prelude::*;
use square_common::account_read;
use square_common::contract::square_escrow_contract::accounts::{ClaimListing, Job};
use square_common::contract::square_escrow_contract::types::{ClaimStatus, JobStatus};
use square_common::contract::square_policy_contract::accounts::{Institution, Policy};
use square_common::seeds::{INSTITUTION_SEED, JOB_SEED, POLICY_SEED};

use crate::errors::VerifierError;

fn linked<T>(result: account_read::ReadResult<T>) -> Result<T> {
    result.map_err(|_| error!(VerifierError::InvalidLinkedAccount))
}

/// square_policy `Institution`'ın güncel yetkilisi: multisig bağlıysa vault'u, değilse kurum anahtarı.
pub fn institution_authority(info: &AccountInfo, policy_program: &Pubkey) -> Result<Pubkey> {
    let institution: Institution = linked(account_read::read_owned(info, policy_program))?;
    linked(account_read::verify_pda_with_bump(
        info.key,
        policy_program,
        &[INSTITUTION_SEED, institution.owner_key.as_ref()],
        institution.bump,
    ))?;
    Ok(institution.multisig_vault.unwrap_or(institution.owner_key))
}

/// square_policy `Policy`; `institution`'a ait olmalı. Adres politikanın kendi alanlarıyla doğrulanır:
/// başka bir kurumun gerçek politikası `PolicyMismatch`, policy programının hesabı olmayan
/// `InvalidLinkedAccount` alır.
pub fn require_policy_of(
    info: &AccountInfo,
    institution: &Pubkey,
    policy_program: &Pubkey,
) -> Result<()> {
    let policy: Policy = linked(account_read::read_owned(info, policy_program))?;
    linked(account_read::verify_pda_with_bump(
        info.key,
        policy_program,
        &[
            POLICY_SEED,
            policy.institution.as_ref(),
            policy.policy_id.as_ref(),
        ],
        policy.bump,
    ))?;
    require_keys_eq!(
        policy.institution,
        *institution,
        VerifierError::PolicyMismatch
    );
    Ok(())
}

/// square_escrow `Job` (`["job", institution_wallet, spec_hash]`).
pub fn job(info: &AccountInfo, escrow_program: &Pubkey) -> Result<Job> {
    let job: Job = linked(account_read::read_owned(info, escrow_program))?;
    linked(account_read::verify_pda_with_bump(
        info.key,
        escrow_program,
        &[JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        job.bump,
    ))?;
    Ok(job)
}

/// İspat yalnızca teslim edilmiş ya da dispute'taki işe bağlanır (program arayüzü §4).
pub fn require_bindable(job: &Job) -> Result<()> {
    match job.status {
        JobStatus::Delivered | JobStatus::Disputed => Ok(()),
        _ => err!(VerifierError::InvalidJobState),
    }
}

/// Release'in ödeyeceği adres: alacak satıldıysa (`ClaimListing.status == Bought`) alıcı, değilse
/// `Job.agent_wallet`. `claim_listing`'in adresi `["claim", job]` kısıtıyla bağlıdır; hesap yoksa (henüz
/// listelenmemiş) payee agent'tır.
pub fn payee(
    job_key: &Pubkey,
    job: &Job,
    claim_listing: &AccountInfo,
    escrow_program: &Pubkey,
) -> Result<Pubkey> {
    if claim_listing.data_is_empty() {
        return Ok(job.agent_wallet);
    }
    let listing: ClaimListing = linked(account_read::read_owned(claim_listing, escrow_program))?;
    require_keys_eq!(listing.job, *job_key, VerifierError::InvalidLinkedAccount);
    Ok(match listing.status {
        ClaimStatus::Bought => listing.buyer,
        ClaimStatus::Listed | ClaimStatus::Settled | ClaimStatus::Defaulted => job.agent_wallet,
    })
}
