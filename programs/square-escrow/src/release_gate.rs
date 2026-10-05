//! Release'in ispat kapısı (BC-24; ADR 0012, ADR 0013). Policy'siz işte kapı yoktur. Policy'li işte escrow
//! verifier'ın `ReleaseProof`'unu ve kurumun `OperatorState`'ini CPI'sız okur (owner `config.verifier_program`,
//! PDA kaydın kendi alanlarıyla), ispatı release'in hâline karşı tazelik kuralından geçirir
//! (`square_common::release::check_fresh`) ve kararı verir: uyumlu ispat ödenir, kesin ret iade edilir;
//! ispat yoksa ya da ret geçiciyse escrow bekler.

use anchor_lang::prelude::*;
use square_common::account_read;
use square_common::contract::square_verifier_contract::accounts::{OperatorState, ReleaseProof};
use square_common::contract::square_verifier_contract::cpi;
use square_common::contract::square_verifier_contract::types::ReleaseVerdict;
use square_common::release::{check_fresh, is_final_refusal, ReleaseFacts};
use square_common::seeds::{ESCROW_AUTHORITY_SEED, OPERATOR_STATE_SEED};

use crate::errors::EscrowError;

/// Kapının kararı.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// Policy'siz iş: payee'ye ödenir.
    NoGate,
    /// Uyumlu ve taze ispat: payee'ye ödenir, `record_release` sayacı ilerletir.
    Verified { release_proof: Pubkey },
    /// Kesin ret: net kuruma iade edilir, `record_release` ispatı tüketir.
    Refused {
        release_proof: Pubkey,
        refusal_code: u16,
    },
}

impl Gate {
    pub fn pays_agent_side(self) -> bool {
        !matches!(self, Self::Refused { .. })
    }

    pub fn release_proof(self) -> Option<Pubkey> {
        match self {
            Self::NoGate => None,
            Self::Verified { release_proof } | Self::Refused { release_proof, .. } => {
                Some(release_proof)
            }
        }
    }
}

fn invalid<T>(result: account_read::ReadResult<T>) -> Result<T> {
    result.map_err(|_| error!(EscrowError::InvalidReleaseProof))
}

/// Policy'li işin bağlı ispatı ve kurumun sayacı.
fn read_proof(
    job: &Pubkey,
    policy: &Pubkey,
    release_proof: Option<&AccountInfo>,
    operator_state: Option<&AccountInfo>,
    verifier_program: &Pubkey,
) -> Result<(ReleaseProof, OperatorState)> {
    let info = match release_proof {
        Some(info) if !info.data_is_empty() => info,
        _ => return err!(EscrowError::ProofRequired),
    };
    let proof: ReleaseProof = invalid(account_read::read_owned(info, verifier_program))?;
    require!(
        proof.job == *job && proof.policy == *policy && !proof.consumed,
        EscrowError::InvalidReleaseProof
    );
    let state_info = operator_state.ok_or(EscrowError::InvalidReleaseProof)?;
    let state: OperatorState = invalid(account_read::read_owned(state_info, verifier_program))?;
    invalid(account_read::verify_pda_with_bump(
        state_info.key,
        verifier_program,
        &[OPERATOR_STATE_SEED, proof.institution.as_ref()],
        state.bump,
    ))?;
    Ok((proof, state))
}

/// İşin release'i için kapının kararı. Hata, escrow'un beklediği anlamına gelir: `ProofRequired`
/// (ispat yok ya da ret geçici), `StaleReleaseProof` (ispat release'in hâline uymuyor).
pub fn decide(
    job: &Pubkey,
    policy: Option<Pubkey>,
    release_proof: Option<&AccountInfo>,
    operator_state: Option<&AccountInfo>,
    verifier_program: &Pubkey,
    facts: &ReleaseFacts,
    now: i64,
) -> Result<Gate> {
    let Some(policy) = policy else {
        return Ok(Gate::NoGate);
    };
    let (proof, state) = read_proof(
        job,
        &policy,
        release_proof,
        operator_state,
        verifier_program,
    )?;
    check_fresh(&proof, &state, facts, now).map_err(|_| error!(EscrowError::StaleReleaseProof))?;
    let release_proof = release_proof.map(|info| *info.key).unwrap_or_default();
    match proof.verdict {
        ReleaseVerdict::Compliant => Ok(Gate::Verified { release_proof }),
        ReleaseVerdict::Refused
            if is_final_refusal(proof.refusal_code, proof.daily_spent_before) =>
        {
            Ok(Gate::Refused {
                release_proof,
                refusal_code: proof.refusal_code,
            })
        }
        ReleaseVerdict::Refused => err!(EscrowError::ProofRequired),
    }
}

/// Verifier'ın `record_release`'i: escrow'un tek CPI'ı, `["escrow_authority"]` PDA'sı imzalar.
pub fn record_release<'info>(
    verifier_program: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    verifier_config: &AccountInfo<'info>,
    release_proof: &AccountInfo<'info>,
    operator_state: &AccountInfo<'info>,
    escrow_authority_bump: u8,
) -> Result<()> {
    let bump = [escrow_authority_bump];
    let seeds: &[&[u8]] = &[ESCROW_AUTHORITY_SEED, &bump];
    cpi::record_release(CpiContext::new_with_signer(
        verifier_program.key(),
        cpi::accounts::RecordRelease {
            escrow_authority: escrow_authority.clone(),
            config: verifier_config.clone(),
            release_proof: release_proof.clone(),
            operator_state: operator_state.clone(),
        },
        &[seeds],
    ))
}
