//! square_escrow'un durum makinesinde tohumlu fuzz ve invariant testi (BC-39). Her tohum policy'siz işlerle
//! rastgele bir işlem dizisi koşar: iş açma, fonlama, kabul, teslim, iptal, alacak listeleme / alım / geri
//! çekme, finalize, bond'lu dispute, oy, kararın yürütülmesi, lapse, arbitrator seti değişimi, vault'a bağış,
//! screening değişimi ve zaman atlaması. İşlemlerin bir kısmı yetkisiz imzacıyla, saldırganın token
//! hesabıyla ya da sınırın dışındaki değerlerle denenir. Her adımdan sonra:
//!
//! 1. **Bakiye modeli:** Başarılı işlemde her izlenen token hesabının farkı kuralın beklediği farktır (net,
//!    keeper ücreti, iade, bond, vault'taki fazla); başarısız işlemde hiçbir bakiye değişmez.
//! 2. **Korunum:** İzlenen hesapların toplamı basılan miktara eşittir; değer izlenmeyen bir hesaba sızmaz.
//! 3. **Escrow'un ödeme gücü:** Fonlanmış işin vault'u `amount`'tan az tutmaz; kapanan işin vault'u kalmaz.
//! 4. **Bond'un ödeme gücü:** Bond'lu açık dispute'un bond vault'u `dispute.bond`'dan az tutmaz; dispute
//!    kapanınca bond vault'u kalmaz.
//! 5. **Durum makinesi:** Geçişler yalnızca izinli kenarlardandır; iş başına bir dispute açılır; ödemede
//!    alacak listelemesi `Settled`, iadede `Defaulted` olur.
//! 6. **Saldırgan:** Saldırganın bakiyesi hiçbir adımda artmaz.
//!
//! Policy'li işlerin ispat kapısı gerçek Groth16 ispatı ister; o dallar `release_gate.rs` ve
//! `dispute_gate.rs`'teki deterministik testlerdedir. Tohum sayısı `SQUARE_FUZZ_SEEDS` (varsayılan 16), adım
//! sayısı `SQUARE_FUZZ_STEPS` (varsayılan 120); düşen bir tohum `SQUARE_FUZZ_SEED=<n>` ile yeniden koşar.

mod escrow_world;

use std::collections::{BTreeMap, HashMap};

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use escrow_world::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_escrow::state::{ClaimListing, ClaimStatus, DisputeResolution, Job, JobStatus};
use square_program_tests::token::{self, TOKEN_PROGRAM_ID};
use square_registry::ScreeningStatus;

const INSTITUTIONS: usize = 2;
const AGENTS: usize = 2;
const BUYERS: usize = 2;
const KEEPERS: usize = 2;
/// Aynı anda yaşayan iş sayısı; kapanan işin yerine yenisi açılır.
const SLOTS: usize = 4;
/// Her tarafın başlangıç bakiyesi (USDC taban birimi).
const FUNDS: u64 = 1_000_000 * 1_000_000;
/// Keeper'ın ve saldırganın SOL'ü: `finalize_payment` ve `execute_resolution` itibar ve validation kaydının
/// rent'ini tetikleyene ödetir.
const LAMPORTS: u64 = 100_000_000_000;
const BPS_DENOMINATOR: u128 = 10_000;

/// SplitMix64: bağımlılıksız, tohumdan yeniden üretilebilir.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// `[low, high]` aralığında.
    fn range(&mut self, low: u64, high: u64) -> u64 {
        low + self.next() % (high - low + 1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn index(&mut self, len: usize) -> usize {
        (self.next() % len as u64) as usize
    }
}

/// Yaşayan bir iş: kurumu, agent'ı ve açılış anı (adres `job_address(kurum, spec)`).
struct Slot {
    institution: usize,
    agent: usize,
    job: Pubkey,
}

struct Fuzz {
    w: World,
    rng: Rng,
    seed: u64,
    step: usize,
    institutions: Vec<Institution>,
    agents: Vec<Agent>,
    buyers: Vec<Buyer>,
    keepers: Vec<Keypair>,
    attacker: Institution,
    slots: Vec<Option<Slot>>,
    /// Bu adımın işi (yönlendirilmiş seçimde); yoksa işlem rastgele bir iş seçer.
    target: Option<usize>,
    /// Açılmış bütün işler ve son görülen durumları (kapananlar da: kapanan iş bir daha değişmemeli).
    jobs: Vec<(Pubkey, JobStatus)>,
    /// İş başına başarılı `raise_dispute` sayısı.
    disputes: HashMap<Pubkey, u32>,
    minted: u128,
    specs: u64,
    log: Vec<String>,
    /// İşlem adına (başarılı, başarısız) sayısı.
    stats: BTreeMap<&'static str, (u32, u32)>,
    /// (işlem, ret kodu) başına reddedilme sayısı; `-- --nocapture` ile yazılır.
    rejections: BTreeMap<(&'static str, String), u32>,
}

/// Başarılı adımdan sonra modelin güncellenmesi (yeni iş, dispute sayısı, panel).
type ModelUpdate = Box<dyn FnOnce(&mut Fuzz)>;

/// Bir adımın talimatı, imzacıları ve başarılı olursa beklenen token farkları.
struct Attempt {
    op: &'static str,
    detail: String,
    ixs: Vec<Instruction>,
    signers: Vec<Keypair>,
    deltas: HashMap<Pubkey, i128>,
    /// Başarılıysa yapılacak model güncellemesi.
    on_success: Option<ModelUpdate>,
}

impl Attempt {
    fn new(op: &'static str, detail: String, ixs: Vec<Instruction>, signers: Vec<Keypair>) -> Self {
        Self {
            op,
            detail,
            ixs,
            signers,
            deltas: HashMap::new(),
            on_success: None,
        }
    }

    fn delta(mut self, account: Pubkey, amount: i128) -> Self {
        *self.deltas.entry(account).or_insert(0) += amount;
        self
    }
}

fn keeper_fee(amount: u64) -> u64 {
    (u128::from(amount) * u128::from(params().keeper_fee_bps) / BPS_DENOMINATOR) as u64
}

fn min_bond(amount: u64) -> u64 {
    let p = params();
    let relative = (u128::from(amount) * u128::from(p.min_bond_bps) / BPS_DENOMINATOR) as u64;
    relative.max(p.min_bond_absolute)
}

/// İzinli durum geçişleri (program arayüzü §state machine; cancel_job, lapse_dispute, execute_resolution).
fn allowed(from: JobStatus, to: JobStatus) -> bool {
    use JobStatus::*;
    from == to
        || matches!(
            (from, to),
            (Open, Funded)
                | (Open, Cancelled)
                | (Funded, Accepted)
                | (Funded, Cancelled)
                | (Accepted, Delivered)
                | (Accepted, Cancelled)
                | (Delivered, Disputed)
                | (Delivered, Released)
                | (Delivered, Refunded)
                | (Disputed, Resolved)
                | (Disputed, Delivered)
                | (Resolved, Released)
                | (Resolved, Refunded)
        )
}

/// Vault'u yaşayan durumlar.
fn holds_vault(status: JobStatus) -> bool {
    !matches!(
        status,
        JobStatus::Released | JobStatus::Refunded | JobStatus::Cancelled
    )
}

/// Vault'un `amount`'ı tutması gereken durumlar.
fn funded(status: JobStatus) -> bool {
    matches!(
        status,
        JobStatus::Funded
            | JobStatus::Accepted
            | JobStatus::Delivered
            | JobStatus::Disputed
            | JobStatus::Resolved
    )
}

impl Fuzz {
    fn new(seed: u64) -> Self {
        let mut w = World::new(true);
        let mut minted = 0u128;
        let institutions: Vec<Institution> = (0..INSTITUTIONS)
            .map(|_| {
                let institution = w.institution(FUNDS);
                w.screen(&institution.key.pubkey(), ScreeningStatus::Clear);
                minted += u128::from(FUNDS);
                institution
            })
            .collect();
        let usdc = w.usdc;
        let agents: Vec<Agent> = (0..AGENTS)
            .map(|i| {
                let agent = w.register_agent(&format!("fuzz-agent-{i}"));
                w.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);
                token::create_ata(&mut w.h, &agent.wallet.pubkey(), &usdc);
                agent
            })
            .collect();
        let buyers: Vec<Buyer> = (0..BUYERS)
            .map(|_| {
                minted += u128::from(FUNDS);
                w.buyer(FUNDS)
            })
            .collect();
        let keepers: Vec<Keypair> = (0..KEEPERS)
            .map(|_| {
                let keeper = w.h.funded(LAMPORTS);
                token::create_ata(&mut w.h, &keeper.pubkey(), &usdc);
                keeper
            })
            .collect();
        let attacker = w.institution(FUNDS);
        w.h.svm
            .airdrop(&attacker.key.pubkey(), LAMPORTS)
            .expect("airdrop");
        w.screen(&attacker.key.pubkey(), ScreeningStatus::Clear);
        minted += u128::from(FUNDS);
        Self {
            w,
            rng: Rng(seed),
            seed,
            step: 0,
            institutions,
            agents,
            buyers,
            keepers,
            attacker,
            slots: (0..SLOTS).map(|_| None).collect(),
            target: None,
            jobs: Vec::new(),
            disputes: HashMap::new(),
            minted,
            specs: 0,
            log: Vec::new(),
            stats: BTreeMap::new(),
            rejections: BTreeMap::new(),
        }
    }

    // ------------------------------------------------------------------ durum

    fn ata(&self, owner: &Pubkey) -> Pubkey {
        token::ata_address(owner, &self.w.usdc)
    }

    fn job(&self, job: &Pubkey) -> Option<Job> {
        self.w.h.account(job)
    }

    fn listing(&self, job: &Pubkey) -> Option<ClaimListing> {
        self.w.h.account(&claim_address(job))
    }

    /// Ödenecek taraf: alacak satılmışsa alıcı, değilse agent cüzdanı (`settlement::payee`).
    fn payee(&self, job: &Job, key: &Pubkey) -> Pubkey {
        match self.listing(key) {
            Some(listing) if listing.status == ClaimStatus::Bought => listing.buyer,
            _ => job.agent_wallet,
        }
    }

    /// İzlenen token hesapları: tarafların hesapları ve açılmış her işin vault'u ile bond vault'u.
    fn tracked(&self) -> Vec<Pubkey> {
        let mut accounts: Vec<Pubkey> = self
            .institutions
            .iter()
            .map(|i| i.token_account)
            .chain(self.agents.iter().map(|a| self.ata(&a.wallet.pubkey())))
            .chain(self.buyers.iter().map(|b| b.token_account))
            .chain(self.keepers.iter().map(|k| self.ata(&k.pubkey())))
            .chain(std::iter::once(self.attacker.token_account))
            .collect();
        for (job, _) in &self.jobs {
            accounts.push(vault_address(job));
            accounts.push(bond_address(job));
        }
        accounts
    }

    fn snapshot(&self) -> HashMap<Pubkey, u64> {
        self.tracked()
            .into_iter()
            .map(|account| (account, self.w.balance(&account).unwrap_or(0)))
            .collect()
    }

    fn fail(&self, message: String) -> ! {
        let tail: Vec<&String> = self.log.iter().rev().take(25).rev().collect();
        panic!(
            "BC-39 fuzz: tohum {} adım {}: {message}\nyeniden üretmek için SQUARE_FUZZ_SEED={}\nson adımlar:\n{}",
            self.seed,
            self.step,
            self.seed,
            tail.iter()
                .map(|line| format!("  {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    // ------------------------------------------------------------------ adım

    fn run(&mut self, steps: usize) {
        for step in 0..steps {
            self.step = step;
            let attempt = self.choose();
            self.execute(attempt);
            self.check();
        }
    }

    fn execute(&mut self, attempt: Attempt) {
        let before = self.snapshot();
        let attacker_before = before[&self.attacker.token_account];
        let signers: Vec<&Keypair> = attempt.signers.iter().collect();
        let outcome = self.w.h.send(&attempt.ixs, &signers);
        let after = self.snapshot();
        let ok = outcome.is_ok();
        let entry = self.stats.entry(attempt.op).or_insert((0, 0));
        if ok {
            entry.0 += 1;
        } else {
            entry.1 += 1;
        }
        let result = match &outcome {
            Ok(_) => "ok".to_string(),
            Err(failed) => {
                let code = failed
                    .custom_code()
                    .map_or_else(|| format!("{:?}", failed.error), |code| code.to_string());
                *self
                    .rejections
                    .entry((attempt.op, code.clone()))
                    .or_insert(0) += 1;
                format!("ret {code}")
            }
        };
        self.log
            .push(format!("{} {} → {result}", attempt.op, attempt.detail));

        for (account, new) in &after {
            let old = before.get(account).copied().unwrap_or(0);
            let actual = i128::from(*new) - i128::from(old);
            let expected = if ok {
                attempt.deltas.get(account).copied().unwrap_or(0)
            } else {
                0
            };
            if actual != expected {
                self.fail(format!(
                    "{}: {account} hesabının farkı {actual}, beklenen {expected} ({})",
                    attempt.op,
                    if ok {
                        "başarılı"
                    } else {
                        "başarısız işlem"
                    }
                ));
            }
        }
        if after[&self.attacker.token_account] > attacker_before {
            self.fail(format!("{}: saldırganın bakiyesi arttı", attempt.op));
        }
        if ok {
            if let Some(update) = attempt.on_success {
                update(self);
            }
        }
    }

    /// Adımların çoğu seçilen işin durumuna uygun işlemdir (fuzz durum makinesinin derin kenarlarına ulaşır);
    /// geri kalanı herhangi bir işte herhangi bir işlemdir (yanlış durumda ve yetkisiz denemeler).
    fn choose(&mut self) -> Attempt {
        loop {
            self.target = None;
            let live: Vec<usize> = (0..SLOTS).filter(|i| self.slots[*i].is_some()).collect();
            let attempt = if live.is_empty() || self.rng.chance(25) {
                self.any()
            } else {
                let slot = live[self.rng.index(live.len())];
                self.target = Some(slot);
                self.guided(slot)
            };
            if let Some(attempt) = attempt {
                return attempt;
            }
        }
    }

    fn guided(&mut self, slot: usize) -> Option<Attempt> {
        let job = self.slots[slot].as_ref()?.job;
        let state = self.job(&job)?;
        let now = self.w.h.now();
        let roll = self.rng.next() % 100;
        match state.status {
            JobStatus::Open => match roll {
                0..=69 => self.fund(),
                70..=79 => self.cancel(),
                80..=89 => self.donate(),
                _ => self.advance(),
            },
            JobStatus::Funded => match roll {
                0..=69 => self.accept(),
                70..=79 => self.cancel(),
                80..=89 => self.screen(),
                _ => self.advance(),
            },
            JobStatus::Accepted => match roll {
                0..=69 => self.submit(),
                70..=79 => self.cancel(),
                _ => self.advance(),
            },
            // Challenge penceresi açıkken dispute ve alacak satışı, kapanınca finalize.
            JobStatus::Delivered if now < state.challenge_end => match roll {
                0..=24 => self.raise_dispute(),
                25..=44 => self.list_claim(),
                45..=64 => self.buy_claim(),
                65..=67 => self.cancel_claim(),
                68..=71 => self.finalize(),
                72..=89 => self.advance(),
                90..=94 => self.screen(),
                _ => self.donate(),
            },
            JobStatus::Delivered => match roll {
                0..=59 => self.finalize(),
                60..=64 => self.raise_dispute(),
                65..=74 => self.buy_claim(),
                75..=89 => self.screen(),
                _ => self.donate(),
            },
            // Dispute'un son tarihine kadar oy, sonra lapse.
            JobStatus::Disputed if now < state.dispute.deadline => match roll {
                0..=69 => self.vote(),
                70..=74 => self.lapse(),
                75..=84 => self.advance(),
                85..=89 => self.rotate_panel(),
                _ => self.donate(),
            },
            JobStatus::Disputed => match roll {
                0..=59 => self.lapse(),
                60..=69 => self.vote(),
                70..=79 => self.screen(),
                _ => self.donate(),
            },
            JobStatus::Resolved => match roll {
                0..=79 => self.execute_resolution(),
                80..=89 => self.screen(),
                _ => self.donate(),
            },
            // Kapanmış iş: yerine yenisi açılır ya da kapanmış işte bir işlem denenir (reddedilmeli).
            JobStatus::Released | JobStatus::Refunded | JobStatus::Cancelled => match roll {
                0..=69 => self.create(),
                _ => self.any(),
            },
        }
    }

    fn any(&mut self) -> Option<Attempt> {
        loop {
            let roll = self.rng.next() % 100;
            let attempt = match roll {
                0..=9 => self.create(),
                10..=19 => self.fund(),
                20..=27 => self.accept(),
                28..=35 => self.submit(),
                36..=39 => self.cancel(),
                40..=45 => self.list_claim(),
                46..=50 => self.buy_claim(),
                51..=52 => self.cancel_claim(),
                53..=62 => self.finalize(),
                63..=69 => self.raise_dispute(),
                70..=77 => self.vote(),
                78..=83 => self.execute_resolution(),
                84..=86 => self.lapse(),
                87..=88 => self.donate(),
                89..=90 => self.screen(),
                91 => self.rotate_panel(),
                _ => self.advance(),
            };
            if attempt.is_some() {
                return attempt;
            }
            if self.target.is_some() {
                return None;
            }
        }
    }

    /// Adımın işi: seçilen yuva, yoksa rastgele bir iş.
    fn live(&mut self) -> Option<(usize, Pubkey, Job)> {
        let index = match self.target {
            Some(index) => index,
            None => {
                let live: Vec<usize> = (0..SLOTS).filter(|i| self.slots[*i].is_some()).collect();
                if live.is_empty() {
                    return None;
                }
                live[self.rng.index(live.len())]
            }
        };
        let job = self.slots[index].as_ref()?.job;
        let state = self.job(&job)?;
        Some((index, job, state))
    }

    // ------------------------------------------------------------------ işlemler

    fn create(&mut self) -> Option<Attempt> {
        let free = (0..SLOTS).find(|i| {
            self.slots[*i].as_ref().is_none_or(|slot| {
                !holds_vault(
                    self.job(&slot.job)
                        .map_or(JobStatus::Cancelled, |j| j.status),
                )
            })
        })?;
        let institution = self.rng.index(INSTITUTIONS);
        let agent = self.rng.index(AGENTS);
        self.specs += 1;
        let mut spec = [0u8; 32];
        spec[..8].copy_from_slice(&self.seed.to_le_bytes());
        spec[8..16].copy_from_slice(&self.specs.to_le_bytes());
        let amount = self.rng.range(2_000_000, 400_000_000);
        let now = self.w.h.now();
        let deadline = now + self.rng.range(HOUR as u64, 5 * DAY as u64) as i64;
        let p = params();
        let challenge = if self.rng.chance(5) {
            // Sınırın dışında: config'in aralığı dışındaki pencere reddedilir.
            if self.rng.chance(50) {
                p.min_challenge_period - 1
            } else {
                p.max_challenge_period + 1
            }
        } else {
            self.rng.range(p.min_challenge_period, 2 * DAY as u64)
        };
        let key = self.institutions[institution].key.pubkey();
        let ix = self.w.create_job_ix(
            &key,
            self.agents[agent].record,
            None,
            spec,
            amount,
            deadline,
            challenge,
            self.w.usdc,
        );
        let job = job_address(&key, &spec);
        let signer = self.institutions[institution].key.insecure_clone();
        let mut attempt = Attempt::new(
            "create_job",
            format!("kurum {institution} agent {agent} tutar {amount} pencere {challenge}"),
            vec![ix],
            vec![signer],
        );
        attempt.on_success = Some(Box::new(move |f: &mut Fuzz| {
            f.slots[free] = Some(Slot {
                institution,
                agent,
                job,
            });
            f.jobs.push((job, JobStatus::Open));
        }));
        Some(attempt)
    }

    fn fund(&mut self) -> Option<Attempt> {
        let (index, job, state) = self.live()?;
        let slot = self.slots[index].as_ref()?;
        let rogue = self.rng.chance(10);
        let (signer, source) = if rogue {
            (
                self.attacker.key.insecure_clone(),
                self.attacker.token_account,
            )
        } else {
            let institution = &self.institutions[slot.institution];
            (institution.key.insecure_clone(), institution.token_account)
        };
        let ix = self
            .w
            .fund_job_ix_with(&signer.pubkey(), &job, source, vault_address(&job));
        let amount = i128::from(state.amount);
        Some(
            Attempt::new(
                "fund_job",
                format!("{job} yetkisiz={rogue}"),
                vec![ix],
                vec![signer],
            )
            .delta(source, -amount)
            .delta(vault_address(&job), amount),
        )
    }

    fn accept(&mut self) -> Option<Attempt> {
        let (index, job, state) = self.live()?;
        let slot = self.slots[index].as_ref()?;
        let agent = if self.rng.chance(15) {
            self.rng.index(AGENTS)
        } else {
            slot.agent
        };
        let spec = if self.rng.chance(5) {
            [0xee; 32]
        } else {
            state.spec_hash
        };
        let wallet = self.agents[agent].wallet.insecure_clone();
        let ix = self
            .w
            .accept_ix(&wallet.pubkey(), &job, self.agents[agent].record, spec);
        Some(Attempt::new(
            "accept_job",
            format!("{job} agent {agent}"),
            vec![ix],
            vec![wallet],
        ))
    }

    fn submit(&mut self) -> Option<Attempt> {
        let (index, job, _) = self.live()?;
        let slot = self.slots[index].as_ref()?;
        let agent = if self.rng.chance(15) {
            self.rng.index(AGENTS)
        } else {
            slot.agent
        };
        let wallet = self.agents[agent].wallet.insecure_clone();
        let ix = self.w.submit_ix(
            &wallet.pubkey(),
            &job,
            self.agents[agent].record,
            "ipfs://fuzz-delivery",
        );
        Some(Attempt::new(
            "submit_work",
            format!("{job} agent {agent}"),
            vec![ix],
            vec![wallet],
        ))
    }

    fn cancel(&mut self) -> Option<Attempt> {
        let (index, job, state) = self.live()?;
        let slot = self.slots[index].as_ref()?;
        let institution = &self.institutions[slot.institution];
        let (signer, target) = match self.rng.next() % 10 {
            0 => (
                self.attacker.key.insecure_clone(),
                self.attacker.token_account,
            ),
            1 => (
                institution.key.insecure_clone(),
                self.attacker.token_account,
            ),
            _ => (institution.key.insecure_clone(), institution.token_account),
        };
        let rent_payer = if self.rng.chance(5) {
            self.attacker.key.pubkey()
        } else {
            state.rent_payer
        };
        let vault = vault_address(&job);
        let held = i128::from(self.w.balance(&vault).unwrap_or(0));
        let ix = self
            .w
            .cancel_ix(&signer.pubkey(), &job, target, vault, rent_payer);
        Some(
            Attempt::new("cancel_job", format!("{job}"), vec![ix], vec![signer])
                .delta(target, held)
                .delta(vault, -held),
        )
    }

    fn list_claim(&mut self) -> Option<Attempt> {
        let (index, job, state) = self.live()?;
        let slot = self.slots[index].as_ref()?;
        let price = match self.rng.next() % 10 {
            0 => 0,
            1 => state.amount,
            _ => self.rng.range(1, state.amount - 1),
        };
        let wallet = self.agents[slot.agent].wallet.insecure_clone();
        let ix = self.w.list_claim_ix(&wallet.pubkey(), &job, price);
        Some(Attempt::new(
            "list_claim",
            format!("{job} fiyat {price}"),
            vec![ix],
            vec![wallet],
        ))
    }

    fn buy_claim(&mut self) -> Option<Attempt> {
        let (_, job, _) = self.live()?;
        let listing = self.listing(&job)?;
        let buyer = self.rng.index(BUYERS);
        let price = if self.rng.chance(10) {
            listing.price + 1
        } else {
            listing.price
        };
        let ix = self
            .w
            .buy_claim_ix(&self.buyers[buyer], &job, price, &Eligibility::default());
        let signer = self.buyers[buyer].key.insecure_clone();
        let amount = i128::from(price);
        Some(
            Attempt::new(
                "buy_claim",
                format!("{job} alıcı {buyer} fiyat {price}"),
                vec![ix],
                vec![signer],
            )
            .delta(self.buyers[buyer].token_account, -amount)
            .delta(self.ata(&listing.seller), amount),
        )
    }

    fn cancel_claim(&mut self) -> Option<Attempt> {
        let (index, job, _) = self.live()?;
        let slot = self.slots[index].as_ref()?;
        let listing = self.listing(&job)?;
        let signer = if self.rng.chance(15) {
            self.attacker.key.insecure_clone()
        } else {
            self.agents[slot.agent].wallet.insecure_clone()
        };
        let ix = self
            .w
            .cancel_claim_ix(&signer.pubkey(), &job, listing.rent_payer);
        Some(Attempt::new(
            "cancel_claim",
            format!("{job}"),
            vec![ix],
            vec![signer],
        ))
    }

    /// Settlement hesapları: çoğunlukla doğru taraf, bazen saldırganın hesabı.
    fn settlement_for(
        &mut self,
        institution: usize,
        payee: Pubkey,
        keeper: Pubkey,
    ) -> (Settlement, bool) {
        let mut settlement = Settlement {
            payee,
            payee_token_account: self.ata(&payee),
            institution_token_account: self.institutions[institution].token_account,
            keeper_token_account: self.ata(&keeper),
        };
        let rogue = match self.rng.next() % 20 {
            0 => {
                settlement.payee_token_account = self.attacker.token_account;
                true
            }
            1 => {
                settlement.institution_token_account = self.attacker.token_account;
                true
            }
            2 => {
                settlement.payee = self.attacker.key.pubkey();
                settlement.payee_token_account = self.attacker.token_account;
                true
            }
            _ => false,
        };
        (settlement, rogue)
    }

    fn finalize(&mut self) -> Option<Attempt> {
        let (index, job, state) = self.live()?;
        let institution = self.slots[index].as_ref()?.institution;
        let keeper = self.keepers[self.rng.index(KEEPERS)].insecure_clone();
        let payee = self.payee(&state, &job);
        let (settlement, rogue) = self.settlement_for(institution, payee, keeper.pubkey());
        let vault = vault_address(&job);
        let held = self.w.balance(&vault).unwrap_or(0);
        let fee = keeper_fee(state.amount);
        assert!(
            u128::from(fee) * BPS_DENOMINATOR <= u128::from(state.amount) * 100,
            "keeper ücreti %1'i aşıyor"
        );
        let net = state.amount - fee;
        let surplus = held.saturating_sub(state.amount);
        let ix = self.w.finalize_ix(&keeper.pubkey(), &job, settlement, None);
        Some(
            Attempt::new(
                "finalize_payment",
                format!("{job} keeper {} yetkisiz={rogue}", keeper.pubkey()),
                vec![ix],
                vec![keeper.insecure_clone()],
            )
            .delta(settlement.keeper_token_account, i128::from(fee))
            .delta(settlement.payee_token_account, i128::from(net))
            .delta(settlement.institution_token_account, i128::from(surplus))
            .delta(vault, -i128::from(held)),
        )
    }

    fn raise_dispute(&mut self) -> Option<Attempt> {
        let (index, job, state) = self.live()?;
        let slot = self.slots[index].as_ref()?;
        let floor = min_bond(state.amount);
        let bond = match self.rng.next() % 6 {
            0 => floor - 1,
            1 => floor,
            _ => floor + self.rng.range(0, state.amount),
        };
        let rogue = self.rng.chance(10);
        let challenger = if rogue {
            Institution {
                key: self.attacker.key.insecure_clone(),
                token_account: self.attacker.token_account,
            }
        } else {
            let institution = &self.institutions[slot.institution];
            Institution {
                key: institution.key.insecure_clone(),
                token_account: institution.token_account,
            }
        };
        let ix = self.w.raise_dispute_ix(&challenger, &job, bond);
        let amount = i128::from(bond);
        let mut attempt = Attempt::new(
            "raise_dispute",
            format!("{job} bond {bond} (alt sınır {floor}) yetkisiz={rogue}"),
            vec![ix],
            vec![challenger.key.insecure_clone()],
        )
        .delta(challenger.token_account, -amount)
        .delta(bond_address(&job), amount);
        attempt.on_success = Some(Box::new(move |f: &mut Fuzz| {
            *f.disputes.entry(job).or_insert(0) += 1;
        }));
        Some(attempt)
    }

    fn vote(&mut self) -> Option<Attempt> {
        let (_, job, state) = self.live()?;
        let arbitrator = if self.rng.chance(15) {
            self.attacker.key.insecure_clone()
        } else {
            let panel = &self.w.panel.arbitrators;
            panel[self.rng.index(panel.len())].insecure_clone()
        };
        let resolution = match self.rng.next() % 4 {
            0 => DisputeResolution::FavorAgent,
            1 => DisputeResolution::FavorInstitution,
            _ => DisputeResolution::Split {
                agent_amount: self.rng.range(0, state.amount + 1),
            },
        };
        let ix = self.w.vote_ix(&arbitrator.pubkey(), &job, resolution);
        Some(Attempt::new(
            "resolve_dispute",
            format!("{job} {resolution:?}"),
            vec![ix],
            vec![arbitrator],
        ))
    }

    fn execute_resolution(&mut self) -> Option<Attempt> {
        let (index, job, state) = self.live()?;
        let institution = self.slots[index].as_ref()?.institution;
        let payer = if self.rng.chance(20) {
            self.attacker.key.insecure_clone()
        } else {
            self.keepers[self.rng.index(KEEPERS)].insecure_clone()
        };
        let payee = self.payee(&state, &job);
        let (settlement, rogue) = self.settlement_for(institution, payee, payer.pubkey());
        let (agent_side, slash) = match state.dispute.resolution {
            DisputeResolution::FavorAgent => (state.amount, true),
            DisputeResolution::FavorInstitution | DisputeResolution::Pending => (0, false),
            DisputeResolution::Split { agent_amount } => (agent_amount.min(state.amount), false),
        };
        let vault = vault_address(&job);
        let held = self.w.balance(&vault).unwrap_or(0);
        let bond_vault = bond_address(&job);
        let bond_held = self.w.balance(&bond_vault).unwrap_or(0);
        let bond = state.dispute.bond;
        let surplus = held.saturating_sub(state.amount);
        let bond_surplus = bond_held.saturating_sub(bond);
        let to_payee = agent_side + if slash { bond } else { 0 };
        let to_institution =
            (state.amount - agent_side) + surplus + if slash { 0 } else { bond } + bond_surplus;
        let ix = self.w.execute_ix(&payer.pubkey(), &job, settlement, None);
        Some(
            Attempt::new(
                "execute_resolution",
                format!("{job} {:?} yetkisiz={rogue}", state.dispute.resolution),
                vec![ix],
                vec![payer],
            )
            .delta(settlement.payee_token_account, i128::from(to_payee))
            .delta(
                settlement.institution_token_account,
                i128::from(to_institution),
            )
            .delta(vault, -i128::from(held))
            .delta(bond_vault, -i128::from(bond_held)),
        )
    }

    fn lapse(&mut self) -> Option<Attempt> {
        let (index, job, _) = self.live()?;
        let institution = &self.institutions[self.slots[index].as_ref()?.institution];
        let target = if self.rng.chance(10) {
            self.attacker.token_account
        } else {
            institution.token_account
        };
        let caller = self.keepers[self.rng.index(KEEPERS)].insecure_clone();
        let bond_vault = bond_address(&job);
        let held = i128::from(self.w.balance(&bond_vault).unwrap_or(0));
        let ix = self.w.lapse_ix(&caller.pubkey(), &job, target);
        Some(
            Attempt::new("lapse_dispute", format!("{job}"), vec![ix], vec![caller])
                .delta(target, held)
                .delta(bond_vault, -held),
        )
    }

    /// Saldırgan bir işin vault'una ya da bond vault'una token gönderir: fazla ödemede kuruma döner, vault'un
    /// kapanmasını engellemez.
    fn donate(&mut self) -> Option<Attempt> {
        let (_, job, _) = self.live()?;
        let target = if self.rng.chance(50) {
            vault_address(&job)
        } else {
            bond_address(&job)
        };
        self.w.balance(&target)?;
        let amount = self.rng.range(1, 5_000_000);
        let ix = spl_token_interface::instruction::transfer(
            &TOKEN_PROGRAM_ID,
            &self.attacker.token_account,
            &target,
            &self.attacker.key.pubkey(),
            &[],
            amount,
        )
        .expect("transfer");
        Some(
            Attempt::new(
                "donate",
                format!("{target} {amount}"),
                vec![ix],
                vec![self.attacker.key.insecure_clone()],
            )
            .delta(self.attacker.token_account, -i128::from(amount))
            .delta(target, i128::from(amount)),
        )
    }

    /// Screener bir tarafı işaretler ya da herkesi yeniden temiz kaydeder (screening ömrü 30 gün).
    fn screen(&mut self) -> Option<Attempt> {
        let mut wallets: Vec<Pubkey> = self.agents.iter().map(|a| a.wallet.pubkey()).collect();
        wallets.extend(self.buyers.iter().map(|b| b.key.pubkey()));
        wallets.extend(self.institutions.iter().map(|i| i.key.pubkey()));
        let ixs: Vec<Instruction> = if self.rng.chance(30) {
            let wallet = wallets[self.rng.index(wallets.len())];
            vec![self
                .w
                .record_screening_ix(&wallet, ScreeningStatus::Flagged)]
        } else {
            wallets
                .iter()
                .map(|wallet| self.w.record_screening_ix(wallet, ScreeningStatus::Clear))
                .collect()
        };
        let screener = self.w.screener.insecure_clone();
        Some(Attempt::new(
            "record_screening",
            format!("{} kayıt", ixs.len()),
            ixs,
            vec![screener],
        ))
    }

    /// Admin arbitrator setini değiştirir; açık dispute'larda sayım yeni setle baştan başlar.
    fn rotate_panel(&mut self) -> Option<Attempt> {
        let panel = Panel::new(3, 2);
        let ix =
            self.w
                .update_arbitrators_ix(&self.w.admin.pubkey(), panel.keys(), panel.threshold);
        let admin = self.w.admin.insecure_clone();
        let mut attempt = Attempt::new("update_arbitrators", String::new(), vec![ix], vec![admin]);
        attempt.on_success = Some(Box::new(move |f: &mut Fuzz| {
            f.w.panel = panel;
        }));
        Some(attempt)
    }

    /// Zaman: işin durumuna göre sınırına (challenge penceresinin sonu, son tarih, dispute'un son tarihi; son
    /// saniyesi ya da bir sonrası) ya da küçük bir adım.
    fn advance(&mut self) -> Option<Attempt> {
        let now = self.w.h.now();
        let edge = |at: i64, rng: &mut Rng| at - 1 + rng.range(0, 2) as i64;
        let target = match self.live() {
            Some((_, _, job)) if self.rng.chance(80) => match job.status {
                JobStatus::Delivered if job.challenge_end > now => {
                    edge(job.challenge_end, &mut self.rng)
                }
                JobStatus::Funded | JobStatus::Accepted if job.deadline > now => {
                    edge(job.deadline, &mut self.rng)
                }
                JobStatus::Disputed if job.dispute.deadline > now => {
                    edge(job.dispute.deadline, &mut self.rng)
                }
                _ => now + self.rng.range(1, 6 * HOUR as u64) as i64,
            },
            _ => now + self.rng.range(1, 6 * HOUR as u64) as i64,
        };
        self.w.h.set_time(target.max(now));
        self.log.push(format!("zaman → {}", target - NOW));
        None
    }

    // ------------------------------------------------------------------ invariant'lar

    fn check(&mut self) {
        let balances = self.snapshot();
        let total: u128 = balances.values().map(|b| u128::from(*b)).sum();
        if total != self.minted {
            self.fail(format!(
                "korunum: izlenen toplam {total}, basılan {}",
                self.minted
            ));
        }
        for i in 0..self.jobs.len() {
            let (key, last) = self.jobs[i];
            let job = self
                .job(&key)
                .unwrap_or_else(|| self.fail(format!("{key}: job hesabı kayboldu")));
            if !allowed(last, job.status) {
                self.fail(format!("{key}: izinsiz geçiş {last:?} → {:?}", job.status));
            }
            self.jobs[i].1 = job.status;
            let vault = self.w.balance(&vault_address(&key));
            match (holds_vault(job.status), vault) {
                (true, None) => self.fail(format!("{key}: {:?} işin vault'u yok", job.status)),
                (false, Some(_)) => {
                    self.fail(format!("{key}: {:?} işin vault'u kapanmadı", job.status))
                }
                (true, Some(held)) if funded(job.status) && held < job.amount => {
                    self.fail(format!(
                        "{key}: vault {held} tutuyor, iş {} borçlu ({:?})",
                        job.amount, job.status
                    ))
                }
                _ => {}
            }
            let bond_open = matches!(job.status, JobStatus::Disputed | JobStatus::Resolved)
                && job.dispute.bond > 0;
            match (bond_open, self.w.balance(&bond_address(&key))) {
                (true, None) => {
                    self.fail(format!("{key}: açık bond'lu dispute'un bond vault'u yok"))
                }
                (true, Some(held)) if held < job.dispute.bond => self.fail(format!(
                    "{key}: bond vault {held} tutuyor, bond {}",
                    job.dispute.bond
                )),
                (false, Some(_)) => {
                    self.fail(format!("{key}: dispute kapandı, bond vault'u kalmış"))
                }
                _ => {}
            }
            if self.disputes.get(&key).copied().unwrap_or(0) > 1 {
                self.fail(format!("{key}: ikinci dispute açıldı"));
            }
            if let Some(listing) = self.listing(&key) {
                let expected = match job.status {
                    JobStatus::Released => Some(ClaimStatus::Settled),
                    JobStatus::Refunded => Some(ClaimStatus::Defaulted),
                    _ => None,
                };
                if let Some(expected) = expected {
                    if listing.status != expected {
                        self.fail(format!(
                            "{key}: {:?} işin listelemesi {:?}, beklenen {expected:?}",
                            job.status, listing.status
                        ));
                    }
                }
                if listing.price >= listing.face_value || listing.face_value != job.amount {
                    self.fail(format!("{key}: listeleme fiyatı yüz değerin altında değil"));
                }
            }
        }
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().map(|value| {
        value
            .parse()
            .unwrap_or_else(|_| panic!("{name} bir sayı olmalı: {value}"))
    })
}

#[test]
fn escrow_invariants_hold_under_random_operation_sequences() {
    let steps = env_u64("SQUARE_FUZZ_STEPS").unwrap_or(120) as usize;
    let seeds: Vec<u64> = match env_u64("SQUARE_FUZZ_SEED") {
        Some(seed) => vec![seed],
        None => (1..=env_u64("SQUARE_FUZZ_SEEDS").unwrap_or(16)).collect(),
    };
    let mut totals: BTreeMap<&'static str, (u32, u32)> = BTreeMap::new();
    let mut rejections: BTreeMap<(&'static str, String), u32> = BTreeMap::new();
    for seed in seeds {
        let mut fuzz = Fuzz::new(seed);
        fuzz.run(steps);
        for (op, (ok, failed)) in fuzz.stats {
            let entry = totals.entry(op).or_insert((0, 0));
            entry.0 += ok;
            entry.1 += failed;
        }
        for (key, count) in fuzz.rejections {
            *rejections.entry(key).or_insert(0) += count;
        }
    }
    println!("[fuzz] ret kodları (işlem, kod): {rejections:?}");
    // Her işlem en az bir kez başarıyla koşmalı: fuzz durum makinesinin bütün kenarlarına ulaşıyor.
    for op in [
        "create_job",
        "fund_job",
        "accept_job",
        "submit_work",
        "cancel_job",
        "list_claim",
        "buy_claim",
        "finalize_payment",
        "raise_dispute",
        "resolve_dispute",
        "execute_resolution",
        "lapse_dispute",
        "donate",
    ] {
        let (ok, _) = totals.get(op).copied().unwrap_or((0, 0));
        assert!(ok > 0, "fuzz {op}'u hiç başarıyla koşturmadı: {totals:?}");
    }
    println!("[fuzz] işlem (başarılı / reddedilen): {totals:?}");
}
