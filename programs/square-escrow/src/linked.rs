//! Diğer Square programlarının hesaplarını CPI'sız okuma (program arayüzü §4). Owner, sözleşme IDL'indeki
//! adres değil `EscrowConfig`'teki program kimliğidir; PDA adresi kaydın kendi seed alanlarından yeniden
//! türetilir. Okuma hataları escrow'un hata kodlarına çevrilir.

use anchor_lang::prelude::*;
use square_common::account_read::{self, AccountReadError};
use square_common::contract::square_policy_contract::accounts::{Institution, Policy};
use square_common::contract::square_registry_contract::accounts::AgentRecord;
use square_common::contract::square_registry_contract::types::AgentStatus;
use square_common::merkle::UNRESTRICTED_ROOT;
use square_common::screening::{self, ScreeningRejection};
use square_common::seeds::{AGENT_SEED, INSTITUTION_SEED, POLICY_SEED};

use crate::errors::EscrowError;

/// `create_job`: `registry_program`'a ait, adresi `["agent", creator, agent_id]` olan `AgentRecord`.
pub fn registered_agent(info: &AccountInfo, registry_program: &Pubkey) -> Result<AgentRecord> {
    let record: AgentRecord = account_read::read_owned(info, registry_program)
        .map_err(|_| error!(EscrowError::AgentNotRegistered))?;
    account_read::verify_pda_with_bump(
        info.key,
        registry_program,
        &[
            AGENT_SEED,
            record.creator.as_ref(),
            record.agent_id.as_bytes(),
        ],
        record.bump,
    )
    .map_err(|_| error!(EscrowError::AgentNotRegistered))?;
    Ok(record)
}

/// Adresi `create_job`'da doğrulanıp job'a bağlanmış (`has_one = agent_record`) kayıt.
pub fn bound_agent(info: &AccountInfo) -> Result<AgentRecord> {
    account_read::read_bound(info).map_err(|_| error!(EscrowError::AgentNotRegistered))
}

/// Yeni iş ve kabul için kayıt `Active` olmalı.
pub fn require_active(record: &AgentRecord) -> Result<()> {
    match record.status {
        AgentStatus::Active => Ok(()),
        AgentStatus::Inactive | AgentStatus::Deregistered => err!(EscrowError::AgentInactive),
    }
}

/// Teslimat: kabul edilmiş iş, `Inactive` kayıtla da teslim edilir; kalıcı olarak silinmiş kayıtla edilmez.
pub fn require_registered(record: &AgentRecord) -> Result<()> {
    match record.status {
        AgentStatus::Active | AgentStatus::Inactive => Ok(()),
        AgentStatus::Deregistered => err!(EscrowError::AgentNotRegistered),
    }
}

/// `create_job`'da job'a kopyalanan policy anlık görüntüsü.
pub struct PolicySnapshot {
    pub policy: Pubkey,
    pub commitment: [u8; 32],
    pub daily_ceiling: u64,
    pub version: u32,
}

fn policy_read_error(error: AccountReadError) -> Error {
    match error {
        AccountReadError::WrongOwner => error!(EscrowError::LinkedProgramMismatch),
        AccountReadError::WrongAddress | AccountReadError::InvalidData => {
            error!(EscrowError::PolicyMismatch)
        }
    }
}

/// `create_job`: `policy` ve kurumu (`policy_institution`) `policy_program`'a ait olmalı, politika etkin
/// ve imzacı kurumun güncel yetkilisi olmalı (multisig bağlıysa vault'u, değilse kurum anahtarı).
pub fn policy_snapshot(
    policy_info: &AccountInfo,
    institution_info: &AccountInfo,
    signer: &Pubkey,
    policy_program: &Pubkey,
) -> Result<PolicySnapshot> {
    let institution: Institution =
        account_read::read_owned(institution_info, policy_program).map_err(policy_read_error)?;
    account_read::verify_pda_with_bump(
        institution_info.key,
        policy_program,
        &[INSTITUTION_SEED, institution.owner_key.as_ref()],
        institution.bump,
    )
    .map_err(policy_read_error)?;

    let policy: Policy =
        account_read::read_owned(policy_info, policy_program).map_err(policy_read_error)?;
    require_keys_eq!(
        policy.institution,
        *institution_info.key,
        EscrowError::PolicyMismatch
    );
    account_read::verify_pda_with_bump(
        policy_info.key,
        policy_program,
        &[
            POLICY_SEED,
            institution_info.key.as_ref(),
            policy.policy_id.as_ref(),
        ],
        policy.bump,
    )
    .map_err(policy_read_error)?;

    require!(policy.active, EscrowError::PolicyInactive);
    let authority = institution.multisig_vault.unwrap_or(institution.owner_key);
    require_keys_eq!(*signer, authority, EscrowError::Unauthorized);

    Ok(PolicySnapshot {
        policy: *policy_info.key,
        commitment: policy.commitment,
        daily_ceiling: policy.daily_ceiling,
        version: policy.version,
    })
}

/// `buy_claim`: onaylı alıcı listesinin kökü. Policy'siz işte liste yoktur (kısıtsız kök). Policy'li işte
/// hesap job'un policy'si olmalı ve `policy_program`'a ait olmalı. Kök anlık görüntüden değil politikanın
/// güncel hâlinden okunur: kurum listeyi `set_buyer_root` ile değiştirdikten sonraki alımlar yeni listeye
/// göre değerlendirilir, önceki satışlar geçerli kalır.
pub fn buyer_root(
    policy_info: Option<&AccountInfo>,
    job_policy: Option<Pubkey>,
    policy_program: &Pubkey,
) -> Result<[u8; 32]> {
    match (job_policy, policy_info) {
        (None, None) => Ok(UNRESTRICTED_ROOT),
        (Some(expected), Some(info)) => {
            require_keys_eq!(*info.key, expected, EscrowError::PolicyMismatch);
            let policy: Policy =
                account_read::read_owned(info, policy_program).map_err(policy_read_error)?;
            Ok(policy.buyer_root)
        }
        (Some(_), None) | (None, Some(_)) => err!(EscrowError::PolicyMismatch),
    }
}

/// `fund_job`, `buy_claim`, `finalize_payment`: cüzdanın screening kaydı temiz ve taze olmalı (registry
/// `record_screening`, BC-27).
pub fn require_clear_screening(
    info: &AccountInfo,
    registry_program: &Pubkey,
    wallet: &Pubkey,
    now: i64,
) -> Result<()> {
    screening::require_clear(info, registry_program, wallet, now)
        .map(|_| ())
        .map_err(|rejection| match rejection {
            ScreeningRejection::Missing => error!(EscrowError::ScreeningRequired),
            ScreeningRejection::Flagged => error!(EscrowError::ScreeningFlagged),
            ScreeningRejection::Expired => error!(EscrowError::ScreeningExpired),
        })
}
