//! Settlement yardımcıları: job PDA'sının imzasıyla vault'tan aktarım ve vault kapanışı, alacak
//! listelemesinin okunması ve kapanması. `finalize_payment`, `execute_resolution` ve `lapse_dispute`
//! aynı kuralları kullanır.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use square_common::seeds::JOB_SEED;

use crate::errors::EscrowError;
use crate::state::{ClaimListing, ClaimStatus, Job};

/// Job PDA'sının imza seed'leri; vault ve bond vault'unun token yetkilisi job'dur.
pub struct JobSigner {
    institution: Pubkey,
    spec_hash: [u8; 32],
    bump: [u8; 1],
}

impl JobSigner {
    pub fn new(job: &Job) -> Self {
        Self {
            institution: job.institution,
            spec_hash: job.spec_hash,
            bump: [job.bump],
        }
    }

    fn seeds(&self) -> [&[u8]; 4] {
        [
            JOB_SEED,
            self.institution.as_ref(),
            self.spec_hash.as_ref(),
            &self.bump,
        ]
    }
}

/// Job'un imzasıyla `from` vault'undan `amount` aktarır (0 ise aktarım yapılmaz).
pub fn transfer<'info>(
    signer: &JobSigner,
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    job: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds = signer.seeds();
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: job.clone(),
            },
            &[&seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Job'un imzasıyla boş vault'u kapatır; rent `destination`'a (`job.rent_payer`) döner.
pub fn close<'info>(
    signer: &JobSigner,
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: &AccountInfo<'info>,
    job: &AccountInfo<'info>,
) -> Result<()> {
    let seeds = signer.seeds();
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: destination.clone(),
            authority: job.clone(),
        },
        &[&seeds],
    ))
}

/// `["claim", job]` listelemesi; hesap yoksa (alacak listelenmemiş) `None`.
pub fn read_listing(info: &AccountInfo, job: &Pubkey) -> Result<Option<ClaimListing>> {
    if info.data_is_empty() {
        return Ok(None);
    }
    let listing = ClaimListing::try_deserialize(&mut &info.try_borrow_data()?[..])
        .map_err(|_| error!(EscrowError::ClaimListingMismatch))?;
    require_keys_eq!(listing.job, *job, EscrowError::ClaimListingMismatch);
    Ok(Some(listing))
}

/// Payee çözümlemesi (program arayüzü §6): alacak satıldıysa alıcı, değilse agent cüzdanı.
pub fn payee(job: &Job, listing: Option<&ClaimListing>) -> (Pubkey, bool) {
    match listing {
        Some(l) if matches!(l.status, ClaimStatus::Bought) => (l.buyer, true),
        _ => (job.agent_wallet, false),
    }
}

/// Settlement'ta listeleme: ödemede `Settled` (satılmışsa alıcıya ödendi, satılmamışsa satışa kapandı),
/// iadede `Defaulted` (alıcıya ödenmez).
pub fn settle_listing(info: &AccountInfo, listing: ClaimListing, paid: bool) -> Result<()> {
    let status = if paid {
        ClaimStatus::Settled
    } else {
        ClaimStatus::Defaulted
    };
    let settled = ClaimListing { status, ..listing };
    let mut data = info.try_borrow_mut_data()?;
    settled.try_serialize(&mut &mut data[..])
}
