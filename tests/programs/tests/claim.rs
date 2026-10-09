//! square_escrow alacak piyasası (BC-25): agent teslim edilmiş işin alacağını yüz değerin altında
//! listeler; yalnızca kurumun onaylı listesindeki (policy `buyer_root`), screening'i temiz alıcı alır ve
//! fiyatı satıcıya hemen öder; satılmamış listeleme geri çekilir. Release'te payee alıcıdır, itibar agent'ta
//! kalır (`finalize.rs`, `release_gate.rs`).

mod escrow_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use escrow_world::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::constants::MAX_BUYER_PROOF_DEPTH;
use square_escrow::errors::EscrowError;
use square_escrow::state::{ClaimStatus, JobStatus};
use square_escrow::{ClaimBought, ClaimCancelled, ClaimListed};
use square_program_tests::token;
use square_program_tests::{anchor_error, cu, event};
use square_registry::ScreeningStatus;

const LAMPORTS: u64 = 1_000_000_000;
/// `BuyClaim` hesaplarında `policy` ve `seller_token_account`'un sırası.
const POLICY_INDEX: usize = 4;
const SELLER_TOKEN_INDEX: usize = 7;

/// `open_job(true)`'nun kurumu ve politikası.
fn policy_of(institution: &Institution) -> PolicyAccounts {
    let institution = institution_address(&institution.key.pubkey());
    PolicyAccounts {
        policy: policy_address(&institution, &POLICY_ID),
        institution,
    }
}

/// `count` alıcı (USDC'li, screening'i temiz) ve onları içeren liste; kök kurumun politikasına yazılır.
fn approved_buyers(
    w: &mut World,
    institution: &Institution,
    count: usize,
) -> (BuyerList, Vec<Buyer>) {
    let buyers: Vec<Buyer> = (0..count).map(|_| w.buyer(CLAIM_PRICE)).collect();
    let list = BuyerList::new(
        buyers
            .iter()
            .zip(1u8..)
            .map(|(buyer, salt)| (buyer.key.pubkey(), [salt; 32]))
            .collect(),
    );
    w.set_buyer_root(&institution.key, policy_of(institution), list.root())
        .expect("set_buyer_root");
    (list, buyers)
}

#[track_caller]
fn assert_not_eligible(w: &mut World, buyer: &Buyer, job: &Pubkey, eligibility: &Eligibility) {
    w.buy_claim(buyer, job, CLAIM_PRICE, eligibility)
        .expect_err("listede değil")
        .assert_error(anchor_error(EscrowError::BuyerNotEligible));
}

/// `buy_claim_ix`'in `index`'teki hesabını `account` yapar.
fn with_account(ix: Instruction, index: usize, account: AccountMeta) -> Instruction {
    let accounts = ix
        .accounts
        .iter()
        .enumerate()
        .map(|(i, meta)| {
            if i == index {
                account.clone()
            } else {
                meta.clone()
            }
        })
        .collect();
    Instruction { accounts, ..ix }
}

#[test]
fn an_agent_lists_and_an_approved_buyer_buys() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job_with(true);
    let (list, buyers) = approved_buyers(&mut w, &institution, 3);

    let executed = w
        .list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");
    cu::within_profile("escrow.list_claim", &executed, "listClaim");
    let listed: ClaimListed = event(&executed);
    assert_eq!(
        (listed.job, listed.seller, listed.price, listed.face_value),
        (job, agent.wallet.pubkey(), CLAIM_PRICE, AMOUNT)
    );
    let listing = w.claim(&job);
    assert_eq!(
        (listing.seller, listing.buyer, listing.rent_payer),
        (agent.wallet.pubkey(), Pubkey::default(), w.h.payer.pubkey())
    );
    assert_eq!(
        (listing.status, listing.listed_at, listing.bought_at),
        (ClaimStatus::Listed, w.h.now(), 0)
    );

    let buyer = &buyers[2];
    let executed = w
        .buy_claim(buyer, &job, CLAIM_PRICE, &list.eligibility(2))
        .expect("buy_claim");
    cu::within_profile("escrow.buy_claim (3 alıcılı liste)", &executed, "buyClaim");
    let bought: ClaimBought = event(&executed);
    assert_eq!(
        (bought.job, bought.buyer, bought.price),
        (job, buyer.key.pubkey(), CLAIM_PRICE)
    );
    let listing = w.claim(&job);
    assert_eq!(
        (listing.buyer, listing.status, listing.bought_at),
        (buyer.key.pubkey(), ClaimStatus::Bought, w.h.now())
    );
    // Fiyat satıcıya hemen gider; escrow release'e kadar yerinde kalır.
    let seller_account = token::ata_address(&agent.wallet.pubkey(), &w.usdc);
    assert_eq!(w.balance(&buyer.token_account), Some(0));
    assert_eq!(w.balance(&seller_account), Some(CLAIM_PRICE));
    assert_eq!(w.balance(&vault_address(&job)), Some(AMOUNT));

    // Satılmış alacak bir daha satılamaz, geri çekilemez.
    w.buy_claim(&buyers[0], &job, CLAIM_PRICE, &list.eligibility(0))
        .expect_err("ikinci alım")
        .assert_error(anchor_error(EscrowError::InvalidClaimStatus));
    let ix = w.cancel_claim_ix(&agent.wallet.pubkey(), &job, w.h.payer.pubkey());
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("satılmış listeleme")
        .assert_error(anchor_error(EscrowError::InvalidClaimStatus));
}

#[test]
fn only_a_buyer_on_the_current_list_can_buy() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job_with(true);
    let (list, buyers) = approved_buyers(&mut w, &institution, 4);
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");
    let outsider = w.buyer(CLAIM_PRICE);
    let member = &buyers[1];
    let proof = list.eligibility(1);

    // Yaprak imzacının adresinden kurulur: başkasının salt'ı ve kanıtı işe yaramaz.
    assert_not_eligible(&mut w, &outsider, &job, &proof);
    assert_not_eligible(&mut w, &outsider, &job, &Eligibility::default());
    // Üye, ama yanlış salt, eksik kanıt ya da sınırdan uzun kanıt.
    let wrong_salt = Eligibility {
        leaf_salt: [0xee; 32],
        ..proof.clone()
    };
    assert_not_eligible(&mut w, member, &job, &wrong_salt);
    let short = Eligibility {
        proof: proof.proof[..1].to_vec(),
        ..proof.clone()
    };
    assert_not_eligible(&mut w, member, &job, &short);
    let padded = Eligibility {
        proof: [proof.proof.clone(), vec![[0; 32]; MAX_BUYER_PROOF_DEPTH]].concat(),
        ..proof.clone()
    };
    assert_not_eligible(&mut w, member, &job, &padded);

    // Kurum listeyi değiştirir: alım güncel köke göre değerlendirilir. Tek üyeli listenin kökü yapraktır.
    let renewed = BuyerList::new(vec![(outsider.key.pubkey(), [0x42; 32])]);
    w.set_buyer_root(&institution.key, policy_of(&institution), renewed.root())
        .expect("yeni liste");
    assert_not_eligible(&mut w, member, &job, &proof);
    w.buy_claim(&outsider, &job, CLAIM_PRICE, &renewed.eligibility(0))
        .expect("yeni listedeki alıcı");
    assert_eq!(w.claim(&job).buyer, outsider.key.pubkey());
}

#[test]
fn an_empty_list_or_a_job_without_policy_is_unrestricted() {
    // Politikası olan ama listesi yayımlanmamış iş (kök sıfır).
    let mut w = World::new(true);
    let (_institution, agent, job) = w.delivered_job_with(true);
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");
    let buyer = w.buyer(CLAIM_PRICE);
    let usdc = w.usdc;
    token::create_ata(&mut w.h, &agent.wallet.pubkey(), &usdc);
    let ix = w.buy_claim_ix(&buyer, &job, CLAIM_PRICE, &Eligibility::default());

    // Policy'li işte policy hesabı job'unki olmalı.
    let omitted = with_account(
        ix.clone(),
        POLICY_INDEX,
        AccountMeta::new_readonly(square_escrow::ID, false),
    );
    w.h.send(&[omitted], &[&buyer.key])
        .expect_err("policy hesabı yok")
        .assert_error(anchor_error(EscrowError::PolicyMismatch));
    let foreign = w.institution(0);
    let foreign_policy = w.policy(&foreign.key, POLICY_ID).policy;
    let swapped = with_account(
        ix.clone(),
        POLICY_INDEX,
        AccountMeta::new_readonly(foreign_policy, false),
    );
    w.h.send(&[swapped], &[&buyer.key])
        .expect_err("başka kurumun politikası")
        .assert_error(anchor_error(EscrowError::PolicyMismatch));
    w.h.send(&[ix], &[&buyer.key]).expect("kök sıfır: kısıtsız");

    // Policy'siz iş: liste yoktur; policy hesabı geçilirse reddedilir.
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");
    let buyer = w.buyer(CLAIM_PRICE);
    let usdc = w.usdc;
    token::create_ata(&mut w.h, &agent.wallet.pubkey(), &usdc);
    let ix = w.buy_claim_ix(&buyer, &job, CLAIM_PRICE, &Eligibility::default());
    let policy = w.policy(&institution.key, POLICY_ID).policy;
    let extra = with_account(
        ix.clone(),
        POLICY_INDEX,
        AccountMeta::new_readonly(policy, false),
    );
    w.h.send(&[extra], &[&buyer.key])
        .expect_err("policy'siz işte policy hesabı")
        .assert_error(anchor_error(EscrowError::PolicyMismatch));
    w.h.send(&[ix], &[&buyer.key]).expect("policy'siz iş");
}

#[test]
fn listing_requires_the_agent_wallet_a_delivered_job_and_a_discount() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.accepted_job();
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect_err("teslim edilmemiş iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
    let ix = w.submit_ix(
        &agent.wallet.pubkey(),
        &job,
        agent.record,
        "ipfs://delivery",
    );
    w.h.send(&[ix], &[&agent.wallet]).expect("submit_work");

    let stranger = Keypair::new();
    w.list_claim(&stranger, &job, CLAIM_PRICE)
        .expect_err("agent cüzdanı değil")
        .assert_error(anchor_error(EscrowError::AgentMismatch));
    for price in [0, AMOUNT, AMOUNT + 1] {
        w.list_claim(&agent.wallet, &job, price)
            .expect_err("yüz değerin altında değil")
            .assert_error(anchor_error(EscrowError::InvalidClaimPrice));
    }
    w.list_claim(&agent.wallet, &job, AMOUNT - 1)
        .expect("yüz değerin hemen altı");
    // Job başına tek listeleme.
    let failed = w
        .list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect_err("ikinci listeleme");
    assert!(
        failed.logs.iter().any(|l| l.contains("already in use")),
        "{:?}",
        failed.logs
    );
}

#[test]
fn the_purchase_checks_price_parties_screening_and_accounts() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");
    let buyer = w.buyer(CLAIM_PRICE);
    let open = Eligibility::default();

    // Fiyat listelemeninkiyle aynı olmalı (öne geçme koruması).
    w.buy_claim(&buyer, &job, CLAIM_PRICE - 1, &open)
        .expect_err("farklı fiyat")
        .assert_error(anchor_error(EscrowError::ClaimPriceChanged));
    // Satıcı ve işi fonlayan kurum alamaz. Satıcı kendi ATA'sıyla gelirse aynı yazılabilir hesap iki rolde
    // geçer ve Anchor reddeder; başka bir token hesabıyla gelirse program.
    let usdc = w.usdc;
    let seller_ata = Buyer {
        key: agent.wallet.insecure_clone(),
        token_account: token::create_ata(&mut w.h, &agent.wallet.pubkey(), &usdc),
    };
    w.buy_claim(&seller_ata, &job, CLAIM_PRICE, &open)
        .expect_err("satıcı, kendi ATA'sı")
        .assert_error(anchor_error(
            AnchorErrorCode::ConstraintDuplicateMutableAccount,
        ));
    let seller = Buyer {
        key: agent.wallet.insecure_clone(),
        token_account: token::create_token_account(&mut w.h, &agent.wallet.pubkey(), &usdc),
    };
    w.buy_claim(&seller, &job, CLAIM_PRICE, &open)
        .expect_err("satıcı, ikinci token hesabı")
        .assert_error(anchor_error(EscrowError::BuyerIsSeller));
    let funder = w.buyer_with(institution.key.insecure_clone(), 0);
    w.buy_claim(&funder, &job, CLAIM_PRICE, &open)
        .expect_err("kurum")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    // Alıcının screening'i: yok, işaretli, süresi dolmuş.
    let Institution { key, token_account } = w.institution(CLAIM_PRICE);
    let unscreened = Buyer { key, token_account };
    w.buy_claim(&unscreened, &job, CLAIM_PRICE, &open)
        .expect_err("kaydı yok")
        .assert_error(anchor_error(EscrowError::ScreeningRequired));
    w.screen(&unscreened.key.pubkey(), ScreeningStatus::Flagged);
    w.buy_claim(&unscreened, &job, CLAIM_PRICE, &open)
        .expect_err("işaretli")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    w.h.advance(SCREENING_TTL);
    w.buy_claim(&buyer, &job, CLAIM_PRICE, &open)
        .expect_err("süresi dolmuş")
        .assert_error(anchor_error(EscrowError::ScreeningExpired));
    w.screen(&buyer.key.pubkey(), ScreeningStatus::Clear);

    // Fiyat listelemenin satıcısına gider.
    let ix = w.buy_claim_ix(&buyer, &job, CLAIM_PRICE, &open);
    let elsewhere = with_account(
        ix,
        SELLER_TOKEN_INDEX,
        AccountMeta::new(institution.token_account, false),
    );
    w.h.send(&[elsewhere], &[&buyer.key])
        .expect_err("satıcının olmayan token hesabı")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintTokenOwner));
    w.buy_claim(&buyer, &job, CLAIM_PRICE, &open)
        .expect("buy_claim");
}

#[test]
fn a_listing_by_a_replaced_wallet_cannot_be_sold() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.delivered_job();
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");
    let rotated = Keypair::new();
    w.rotate_wallet(&agent, rotated.pubkey())
        .expect("update_agent");
    let ix = w.sync_ix(&agent.owner.pubkey(), &job, agent.record);
    w.h.send(&[ix], &[&agent.owner]).expect("sync_agent_wallet");

    let buyer = w.buyer(CLAIM_PRICE);
    w.buy_claim(&buyer, &job, CLAIM_PRICE, &Eligibility::default())
        .expect_err("eski cüzdanın listelemesi")
        .assert_error(anchor_error(EscrowError::InvalidClaimStatus));

    // Eski cüzdan listelemeyi geri çeker; yeni cüzdan yeniden listeler ve satar.
    let ix = w.cancel_claim_ix(&agent.wallet.pubkey(), &job, w.h.payer.pubkey());
    w.h.send(&[ix], &[&agent.wallet]).expect("cancel_claim");
    w.list_claim(&rotated, &job, CLAIM_PRICE)
        .expect("yeni cüzdanla listeleme");
    w.buy_claim(&buyer, &job, CLAIM_PRICE, &Eligibility::default())
        .expect("buy_claim");
    assert_eq!(
        w.balance(&token::ata_address(&rotated.pubkey(), &w.usdc)),
        Some(CLAIM_PRICE)
    );
}

#[test]
fn the_seller_withdraws_an_unsold_listing_and_the_sponsor_gets_the_rent() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.delivered_job();
    let sponsor = w.h.funded(LAMPORTS);
    let ix = with_account(
        w.list_claim_ix(&agent.wallet.pubkey(), &job, CLAIM_PRICE),
        0,
        AccountMeta::new(sponsor.pubkey(), true),
    );
    w.h.send(&[ix], &[&sponsor, &agent.wallet])
        .expect("sponsorlu listeleme");
    assert_eq!(w.claim(&job).rent_payer, sponsor.pubkey());
    assert!(w.h.lamports(&sponsor.pubkey()) < LAMPORTS);

    let stranger = Keypair::new();
    let ix = w.cancel_claim_ix(&stranger.pubkey(), &job, sponsor.pubkey());
    w.h.send(&[ix], &[&stranger])
        .expect_err("satıcı değil")
        .assert_error(anchor_error(EscrowError::NotClaimSeller));
    let ix = w.cancel_claim_ix(&agent.wallet.pubkey(), &job, w.h.payer.pubkey());
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("rent'i ödeyen değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    let ix = w.cancel_claim_ix(&agent.wallet.pubkey(), &job, sponsor.pubkey());
    let executed = w.h.send(&[ix], &[&agent.wallet]).expect("cancel_claim");
    cu::within_profile("escrow.cancel_claim", &executed, "cancelClaim");
    assert_eq!(event::<ClaimCancelled>(&executed).job, job);
    assert_eq!(w.h.lamports(&claim_address(&job)), 0);
    assert_eq!(w.h.lamports(&sponsor.pubkey()), LAMPORTS);

    // Geri çekilen alacak yeniden listelenebilir.
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE / 2)
        .expect("yeniden listeleme");
    assert_eq!(w.claim(&job).price, CLAIM_PRICE / 2);
}

#[test]
fn an_unsold_listing_closes_for_buying_when_the_agent_is_paid() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    w.h.set_time(w.job(&job).challenge_end);
    w.finalize(&keeper, &job, settlement)
        .expect("finalize_payment");
    assert_eq!(w.job(&job).status, JobStatus::Released);
    assert_eq!(w.claim(&job).status, ClaimStatus::Settled);

    let buyer = w.buyer(CLAIM_PRICE);
    w.buy_claim(&buyer, &job, CLAIM_PRICE, &Eligibility::default())
        .expect_err("iş kapandı")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
    let ix = w.cancel_claim_ix(&agent.wallet.pubkey(), &job, w.h.payer.pubkey());
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("kapanmış listeleme")
        .assert_error(anchor_error(EscrowError::InvalidClaimStatus));
}

#[test]
fn the_deepest_buyer_list_fits_one_transaction() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job_with(true);
    let buyer = w.buyer(CLAIM_PRICE);
    // 2^15 + 1 üye: ilk üyenin kanıtı en uzun hâlinde, 16 kardeş.
    let members = std::iter::once((buyer.key.pubkey(), [0x11; 32]))
        .chain((0..1u32 << 15).map(|_| (Pubkey::new_unique(), [0x22; 32])))
        .collect();
    let list = BuyerList::new(members);
    let eligibility = list.eligibility(0);
    assert_eq!(eligibility.proof.len(), MAX_BUYER_PROOF_DEPTH);
    w.set_buyer_root(&institution.key, policy_of(&institution), list.root())
        .expect("set_buyer_root");
    w.list_claim(&agent.wallet, &job, CLAIM_PRICE)
        .expect("list_claim");

    let executed = w
        .buy_claim(&buyer, &job, CLAIM_PRICE, &eligibility)
        .expect("buy_claim");
    cu::within_profile(
        "escrow.buy_claim (16 seviyeli liste)",
        &executed,
        "buyClaim",
    );
}
