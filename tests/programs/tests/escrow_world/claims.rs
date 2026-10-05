//! Alacak piyasası (BC-25): `list_claim`, `buy_claim`, `cancel_claim`, kurumun alıcı listesi (policy
//! `set_buyer_root`) ve listenin Merkle ağacı. Ağaç program arayüzünün kuralıyla kurulur (yaprak
//! `sha256(buyer ‖ salt)`, sıralı çift, tek kalan düğüm üste taşınır); düğümleri `square_common::merkle`
//! hesaplar.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::merkle::{buyer_leaf, parent};
use square_escrow::state::ClaimListing;
use square_program_tests::token::{self, TOKEN_PROGRAM_ID};
use square_program_tests::Outcome;
use square_registry::ScreeningStatus;

use super::{
    claim_address, config_address, screening_address, Agent, Institution, PolicyAccounts, World,
    AMOUNT,
};

/// Listeleme fiyatı: yüz değerin %90'ı.
pub const CLAIM_PRICE: u64 = AMOUNT / 10 * 9;

/// USDC'si olan alıcı cüzdanı.
pub struct Buyer {
    pub key: Keypair,
    pub token_account: Pubkey,
}

/// Alıcının listede olduğunu gösteren yaprak salt'ı ve kanıtı; kısıtsız listede ikisi de boş.
#[derive(Clone, Debug, Default)]
pub struct Eligibility {
    pub leaf_salt: [u8; 32],
    pub proof: Vec<[u8; 32]>,
}

/// Kurumun onaylı alıcı listesi: üyeler `(adres, salt)` sırasıyla yapraktır.
pub struct BuyerList {
    members: Vec<(Pubkey, [u8; 32])>,
    levels: Vec<Vec<[u8; 32]>>,
}

impl BuyerList {
    pub fn new(members: Vec<(Pubkey, [u8; 32])>) -> Self {
        let leaves: Vec<[u8; 32]> = members
            .iter()
            .map(|(buyer, salt)| buyer_leaf(buyer, salt))
            .collect();
        let mut levels = vec![leaves];
        while levels.last().is_some_and(|level| level.len() > 1) {
            let next = levels
                .last()
                .unwrap()
                .chunks(2)
                .map(|pair| match pair {
                    [a, b] => parent(a, b),
                    [single] => *single,
                    _ => unreachable!("chunks(2)"),
                })
                .collect();
            levels.push(next);
        }
        Self { members, levels }
    }

    pub fn root(&self) -> [u8; 32] {
        self.levels
            .last()
            .and_then(|level| level.first())
            .copied()
            .unwrap_or([0; 32])
    }

    /// `index`'teki üyenin salt'ı ve yapraktan köke kardeşleri (eşi olmayan seviyede kardeş yoktur).
    pub fn eligibility(&self, index: usize) -> Eligibility {
        let proof = self.levels[..self.levels.len() - 1]
            .iter()
            .enumerate()
            .filter_map(|(depth, level)| level.get((index >> depth) ^ 1).copied())
            .collect();
        Eligibility {
            leaf_salt: self.members[index].1,
            proof,
        }
    }
}

impl World {
    /// `amount` USDC'si olan, screening'i temiz alıcı.
    pub fn buyer(&mut self, amount: u64) -> Buyer {
        self.buyer_with(Keypair::new(), amount)
    }

    pub fn buyer_with(&mut self, key: Keypair, amount: u64) -> Buyer {
        let Institution { key, token_account } = self.institution_with(key, amount);
        self.screen(&key.pubkey(), ScreeningStatus::Clear);
        Buyer { key, token_account }
    }

    pub fn claim(&self, job: &Pubkey) -> ClaimListing {
        self.h.account(&claim_address(job)).expect("ClaimListing")
    }

    pub fn list_claim_ix(&self, agent: &Pubkey, job: &Pubkey, price: u64) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::ListClaim {
                payer: self.h.payer.pubkey(),
                agent: *agent,
                job: *job,
                claim_listing: claim_address(job),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::ListClaim { price }.data(),
        }
    }

    /// Agent cüzdanı alacağı listeler; rent'i harness'in ödeyicisi öder.
    pub fn list_claim(&mut self, wallet: &Keypair, job: &Pubkey, price: u64) -> Outcome {
        let ix = self.list_claim_ix(&wallet.pubkey(), job, price);
        self.h.send(&[ix], &[wallet])
    }

    /// `buy_claim`; satıcının token hesabı listelemenin `seller`'ının ATA'sı, policy job'unki.
    pub fn buy_claim_ix(
        &self,
        buyer: &Buyer,
        job: &Pubkey,
        price: u64,
        eligibility: &Eligibility,
    ) -> Instruction {
        let listing = self.claim(job);
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::BuyClaim {
                buyer: buyer.key.pubkey(),
                config: config_address(),
                job: *job,
                claim_listing: claim_address(job),
                policy: self.job(job).policy,
                buyer_screening: screening_address(&buyer.key.pubkey()),
                buyer_token_account: buyer.token_account,
                seller_token_account: token::ata_address(&listing.seller, &self.usdc),
                mint: self.usdc,
                token_program: TOKEN_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::BuyClaim {
                price,
                leaf_salt: eligibility.leaf_salt,
                merkle_proof: eligibility.proof.clone(),
            }
            .data(),
        }
    }

    /// Satıcının token hesabını açar (yoksa) ve alacağı `price`'tan alır.
    pub fn buy_claim(
        &mut self,
        buyer: &Buyer,
        job: &Pubkey,
        price: u64,
        eligibility: &Eligibility,
    ) -> Outcome {
        let seller = self.claim(job).seller;
        let usdc = self.usdc;
        token::create_ata(&mut self.h, &seller, &usdc);
        let ix = self.buy_claim_ix(buyer, job, price, eligibility);
        self.h.send(&[ix], &[&buyer.key])
    }

    /// İşin listeleme fiyatı: yüz değerin %90'ı ([`AMOUNT`]'lık işte [`CLAIM_PRICE`]).
    pub fn claim_price(&self, job: &Pubkey) -> u64 {
        self.job(job).amount / 10 * 9
    }

    /// Alacak [`World::claim_price`]'tan listelenir ve kısıtsız listeden (`buyer_root` sıfır) alınır.
    pub fn sell_claim(&mut self, agent: &Agent, job: &Pubkey, buyer: &Buyer) {
        let price = self.claim_price(job);
        let wallet = agent.wallet.insecure_clone();
        self.list_claim(&wallet, job, price).expect("list_claim");
        self.buy_claim(buyer, job, price, &Eligibility::default())
            .expect("buy_claim");
    }

    pub fn cancel_claim_ix(
        &self,
        seller: &Pubkey,
        job: &Pubkey,
        rent_payer: Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::CancelClaim {
                seller: *seller,
                claim_listing: claim_address(job),
                rent_payer,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::CancelClaim {}.data(),
        }
    }

    /// Kurum politikanın onaylı alıcı listesini yayımlar (square_policy `set_buyer_root`).
    pub fn set_buyer_root(
        &mut self,
        authority: &Keypair,
        policy: PolicyAccounts,
        buyer_root: [u8; 32],
    ) -> Outcome {
        let ix = Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::SetBuyerRoot {
                authority: authority.pubkey(),
                institution: policy.institution,
                policy: policy.policy,
            }
            .to_account_metas(None),
            data: square_policy::instruction::SetBuyerRoot { buyer_root }.data(),
        };
        self.h.send(&[ix], &[authority])
    }
}
