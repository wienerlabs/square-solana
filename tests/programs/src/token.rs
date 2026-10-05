//! SPL Token fikstürleri. Hesaplar ortamdaki gerçek SPL Token ve Associated Token Account programlarının
//! instruction'larıyla oluşturulur; durum elle yazılmaz.

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_signer::Signer;
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_token_interface::state::{Account as TokenAccount, Mint};

use crate::Harness;

/// SPL Token programı (klasik); escrow'un settlement mint'i (USDC) bu programdadır.
pub const TOKEN_PROGRAM_ID: Pubkey = spl_token_interface::ID;

/// USDC'nin ondalık sayısı. Testlerdeki settlement mint'i bu ondalıkla oluşturulur.
pub const USDC_DECIMALS: u8 = 6;

/// `authority`'nin bastığı yeni bir mint.
pub fn create_mint(h: &mut Harness, authority: &Pubkey, decimals: u8) -> Pubkey {
    create_mint_at(h, &Keypair::new(), authority, decimals)
}

/// Adresi `mint` anahtarı olan mint: adresi önceden bilinmesi gereken fikstürler için (ör. release
/// ispatının mint sinyali).
pub fn create_mint_at(h: &mut Harness, mint: &Keypair, authority: &Pubkey, decimals: u8) -> Pubkey {
    let rent = h.svm.minimum_balance_for_rent_exemption(Mint::LEN);
    let create = solana_system_interface::instruction::create_account(
        &h.payer.pubkey(),
        &mint.pubkey(),
        rent,
        Mint::LEN as u64,
        &TOKEN_PROGRAM_ID,
    );
    let init = spl_token_interface::instruction::initialize_mint2(
        &TOKEN_PROGRAM_ID,
        &mint.pubkey(),
        authority,
        None,
        decimals,
    )
    .expect("initialize_mint2");
    h.send(&[create, init], &[mint])
        .expect("mint oluşturulamadı");
    mint.pubkey()
}

/// Settlement mint'i: USDC ondalığıyla yeni bir mint.
pub fn create_usdc_mint(h: &mut Harness, authority: &Pubkey) -> Pubkey {
    create_mint(h, authority, USDC_DECIMALS)
}

/// `owner`'ın `mint` için associated token account'u (yoksa oluşturulur).
pub fn create_ata(h: &mut Harness, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ix = create_associated_token_account_idempotent(
        &h.payer.pubkey(),
        owner,
        mint,
        &TOKEN_PROGRAM_ID,
    );
    h.send(&[ix], &[]).expect("ATA oluşturulamadı");
    get_associated_token_address_with_program_id(owner, mint, &TOKEN_PROGRAM_ID)
}

pub fn mint_to(
    h: &mut Harness,
    mint: &Pubkey,
    authority: &Keypair,
    destination: &Pubkey,
    amount: u64,
) {
    let ix = spl_token_interface::instruction::mint_to(
        &TOKEN_PROGRAM_ID,
        mint,
        destination,
        &authority.pubkey(),
        &[],
        amount,
    )
    .expect("mint_to");
    h.send(&[ix], &[authority]).expect("basım yapılamadı");
}

/// Token hesabının durumu (sahip, mint, bakiye). Hesap yoksa ya da kapatılmışsa None.
pub fn token_account(h: &Harness, address: &Pubkey) -> Option<TokenAccount> {
    let account = h.raw_account(address)?;
    if account.data.is_empty() {
        return None;
    }
    Some(TokenAccount::unpack(&account.data).expect("token hesabı çözülemedi"))
}

/// Token hesabının bakiyesi (taban birim). Hesap yoksa ya da kapatılmışsa None.
pub fn balance(h: &Harness, token_account: &Pubkey) -> Option<u64> {
    self::token_account(h, token_account).map(|account| account.amount)
}
