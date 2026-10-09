# square_escrow

Akışın 3, 4, 5, 6 ve 8. adımları: kurum bir registry agent'ına iş açar, fonlar; agent kabul eder ve teslim
eder, alacağını kurumun onayladığı bir alıcıya satabilir; challenge penceresi kapanınca herkes işi kapatır,
ödeme ispat kapısından geçer. Uyuşmazlıkta M-of-N arbitrator paneli karar verir; karar çıkmazsa dispute
düşer ve iş normal yolundan çözülür.
Arayüz [program arayüzü §6 ve §10.4](../../docs/design/program-interface.md#104-square_escrow)'tedir;
IDL'i sözleşme IDL'iyle (`idl/square_escrow_contract.json`) aynıdır; sözleşmenin bütün talimatları yazılıdır
([`scripts/ci/programs.mjs`](../../scripts/ci/programs.mjs)).

| Talimat | Ne yapar |
|---|---|
| `init_config` | Tekil `EscrowConfig`'i açar; yalnızca programın yükseltme yetkilisi (`program` + `program_data`). Tek settlement mint'i (USDC), arbitrator seti (en fazla 7, `2 <= M <= N`), parametreler, okunan programların kimlikleri |
| `update_params` | Challenge sınırları, bond, keeper ücreti, ispat ve dispute süreleri (`dispute_timeout_secs > 0`, `proof_timeout_secs >= 0`), Travel Rule eşiği; yalnızca `admin` |
| `update_arbitrators` | Arbitrator setini değiştirir (en fazla 7, tekrar ve boş anahtar yok, `2 <= M <= N`) ve `arbitrator_set_version`'ı artırır; yalnızca `admin`. Açık dispute'ların son tarihi değişmez, bir sonraki oy sayımı yeni setle baştan başlatır |
| `create_job` | İşi ve boş vault'unu açar. Agent kaydı registry'ye ait, PDA'sı doğru ve `Active` olmalı; `wallet`'ı job'a kopyalanır. Opsiyonel `policy` + `policy_institution`: policy programına ait, etkin, imzacı kurumun güncel yetkilisi (multisig bağlıysa vault'u); commitment, günlük tavan ve sürüm job'a kopyalanır; tutar public günlük tavanı aşamaz (`AmountAboveDailyCeiling`, ADR 0028). Rent'i `payer` öder |
| `commit_travel_rule` | Kurum `Open` işe Travel Rule kaydının salt'lı commitment'ını bağlar (zincirde yalnızca 32 bayt); fonlamaya kadar değiştirilebilir, sıfır commitment bağlanamaz |
| `fund_job` | `amount`'u kurumun token hesabından vault'a kilitler. Kurumun ve `job.agent_wallet`'ın screening kaydı temiz ve taze olmalı; eşik açıksa ve tutar eşiğe eşit ya da üstündeyse Travel Rule commitment'ı bağlanmış olmalı |
| `accept_job` | Fonlanmış işi (fiat işi açıkken) job'un agent cüzdanı kabul eder; kayıt `Active`, spec hash aynı, deadline geçmemiş. Policy'li işte verifier'ın `["preflight_proof", job]` hesabı (`seeds::program = config.verifier_program`) bu işe, işin policy anlık görüntüsüne ve güncel agent cüzdanına ait olmalı; yoksa `PreflightRequired` (cüzdan `sync_agent_wallet` ile taşındıysa kurum yeniden bağlar) ([ADR 0028](../../docs/decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)) |
| `submit_work` | Teslim: `work_hash`, `delivery_uri` (en fazla 128 bayt); challenge penceresi açılır (`challenge_end = now + challenge_period`). Kabul edilmiş iş `Inactive` kayıtla da teslim edilir, silinmiş kayıtla edilmez |
| `cancel_job` | Kurum `Open` / `Funded` işi, ya da deadline'ı geçmiş `Accepted` işi iptal eder: vault bakiyesi kuruma döner, vault kapanır, rent'i `job.rent_payer`'a |
| `sync_agent_wallet` | Registry'de cüzdanı değişen agent'ın kayıt sahibi, kapanmamış işi kaydın güncel cüzdanına taşır |
| `list_claim` | Agent cüzdanı teslim edilmiş işin alacağını yüz değerin altında (`0 < price < amount`) listeler; job başına tek listeleme, rent'i `payer` öder |
| `buy_claim` | Alıcı listeleme fiyatını satıcıya öder ve payee olur. Fiyat listelemeninkiyle aynı; satıcı job'un güncel agent cüzdanı; alıcı satıcı ya da işin kurumu değil; policy'li işte politikanın güncel `buyer_root`'una karşı Merkle kanıtı (sıfır kök ve policy'siz iş kısıtsız); alıcının screening kaydı temiz ve taze |
| `cancel_claim` | Satıcı satılmamış listelemeyi geri çeker; hesap kapanır, rent `rent_payer`'a döner, alacak yeniden listelenebilir |
| `finalize_payment` | Permissionless: `challenge_end`'den sonra teslim edilmiş işi kapatır. Keeper ücreti (en çok 100 bps) her dalda çağırana. Policy'siz işte ve uyumlu ispatta net payee'ye (satılmış alacakta alıcıya), kesin retta kuruma; ispat yoksa ya da ret geçiciyse `ProofRequired`, bayatsa `StaleReleaseProof` ile bekler. Payee screening'i ödemeden önce. Policy'li işte verifier'ın `record_release` CPI'ı. İtibar agent kaydına, `ValidationRecord`, alacak `Settled` / `Defaulted`, vault kapanır |
| `raise_dispute` | Kurum challenge penceresi içinde teslimata itiraz eder; bond `>= max(amount × min_bond_bps / 10 000, min_bond_absolute)` ve sıfır değil, `["bond", job]` vault'una kilitlenir. İşte tek dispute: lapse olmuş dispute da sayılır |
| `escalate_missing_proof` | Agent'ın policy'li işteki başvurusu: `challenge_end + proof_timeout_secs` (lapse'tan sonra kapanıştan) sonra, bugün işi kapatabilecek bir ispat yoksa (ispat yok, geçici ret, başka günün ispatı ya da neti veya mint'i işinkiyle tutmayan ispat) bond'suz dispute açar |
| `resolve_dispute` | Bir arbitrator oyu; ilk oy kararı belirler, sonrakiler aynı olmalı, kimse iki kez oy vermez. M oyda iş `Resolved` olur. Son tarihten sonra oy yok |
| `execute_resolution` | Permissionless: kararı öder. Agent tarafı tutarı (FavorAgent'ta tamamı, Split'te payı; keeper ücreti yok) payee çözümü ve ispat kapısından geçer; kalan kuruma döner. Bond FavorAgent'ta agent tarafına kesilir, diğer kararlarda kuruma döner. İtibar (`jobs_disputed`), `ValidationRecord`, alacak `Settled` / `Defaulted`, vault'lar kapanır |
| `lapse_dispute` | Permissionless: son tarihte ve sonrasında karara bağlanmamış dispute'un bond'unu kuruma iade eder, iş `Delivered`'a döner ve `finalize_payment` ile çözülür |
| `create_fiat_job` | Fiat rayı (ADR 0024): kurumun Stripe ile ödeyeceği iş. Vault ve fonlama yok, `challenge_period` 0; politika zorunlu, anlık görüntüsü alınır, tutar public günlük tavanı aşamaz; kurumun ve agent cüzdanının screening kaydı temiz ve taze. Event `FiatJobCreated` |
| `cancel_fiat_job` | Kurum `Open` fiat işi ya da deadline'ı geçmiş `Accepted` fiat işi iptal eder; iade yok |
| `finalize_fiat_payment` | Permissionless: verifier'ın `verify_mpp_payment_proof`'uyla bağlanmış uyumlu ve taze ispatı (payee agent, net işin tamamı) `record_release` CPI'ıyla tüketir; itibar, `Verified` `ValidationRecord`, iş `Released`. Challenge beklenmez; token hareketi ve keeper ücreti yok. Fiat işte fonlama, dispute, alacak ve Travel Rule `RailMismatch` alır |

```
Open (-(commit_travel_rule)) -(fund_job)-> Funded -(accept_job)-> Accepted -(submit_work)-> Delivered
  (policy'li iş: Open / Funded'da verifier set_preflight_proof, sonra accept_job)
Delivered -(finalize_payment)-> Released | Refunded
Delivered -(raise_dispute | escalate_missing_proof)-> Disputed -(resolve_dispute × M)-> Resolved
Resolved -(execute_resolution)-> Released | Refunded
Disputed (deadline sonrası) -(lapse_dispute)-> Delivered
Open | Funded | Accepted (deadline sonrası) -(cancel_job)-> Cancelled

Alacak (Delivered iş): -(list_claim)-> Listed -(buy_claim)-> Bought
Listed -(cancel_claim)-> kapanır; finalize_payment: Listed | Bought -> Settled (ödeme) | Defaulted (iade)

Fiat rayı (ADR 0024): Open -(set_preflight_proof, accept_job)-> Accepted -(submit_work)-> Delivered
Delivered -(verifier verify_mpp_payment_proof, finalize_fiat_payment)-> Released
Open | Accepted (deadline sonrası) -(cancel_fiat_job)-> Cancelled
```

- **Diğer programların hesapları** CPI'sız okunur ([`src/linked.rs`](src/linked.rs)): owner
  `EscrowConfig`'teki program kimliğidir, PDA adresi kaydın kendi seed alanlarından yeniden türetilir
  (`square_common::account_read`), screening kuralı `square_common::screening`'dedir.
- **Rol imzacıları rent ödemez:** iş ve vault rent'ini `payer` öder ve `job.rent_payer`'a kaydedilir;
  kurum ve agent cüzdanının lamport'a ihtiyacı yoktur.
- **Covenant'tan korunan guard'lar:** config'i yalnızca yükseltme yetkilisi kurar; iş yalnızca settlement
  mint'iyle açılır ve token hesaplarının mint'i denetlenir; vault, job'un kanonik PDA'sına sabittir (sahte
  boş vault geçilip gerçek fon kilitlenemez); token hesabının sahibi imzacıdır.
- **İspat kapısı ve release kuralları** ([`src/release_gate.rs`](src/release_gate.rs)): tazelik
  [ADR 0012](../../docs/decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md); keeper ücretinin tavanı, hangi
  retlerin iade ettiği, payee screening'i ve itibar [ADR 0013](../../docs/decisions/0013-release-keeper-ucreti-iade-ve-itibar.md).
  Aynı token hesabı birden çok rolde gelebilir (keeper agent ya da kurum olabilir; `dup`).
- **Alacak piyasası:** satıcı, alıcı ve onaylı liste kuralları
  [ADR 0014](../../docs/decisions/0014-alacak-piyasasi-satici-ve-alici-kurallari.md)'te; Merkle kanıtı
  `square_common::merkle` ile doğrulanır. Satılmış alacakta payee alıcıdır, itibar agent kaydında kalır.
- **Travel Rule:** commitment'ın tanımı, eşik ve bağlama kuralları
  [ADR 0015](../../docs/decisions/0015-travel-rule-commitment-ve-esik.md)'te; hesaplama
  `square_common::travel_rule` (SDK'da `travelRule`).
- **Fiat rayı:** `Job.rail` (hesabın sonunda; eski hesaplar `Escrow` okunur), attestation, ispat ve kapanış
  kuralları [ADR 0024](../../docs/decisions/0024-stripe-mpp-fiat-rayi.md)'te.
- **Uyuşmazlık:** M-of-N oy, set değişimi, son tarih, lapse, ispatsız bekleme başvurusu ve kararın ödenmesi
  [ADR 0016](../../docs/decisions/0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md)'da; kurallar
  [`src/dispute.rs`](src/dispute.rs)'te (birim testli), settlement yardımcıları `finalize_payment` ile ortak
  ([`src/settlement.rs`](src/settlement.rs)). Covenant'ın 2-of-3 dispute talimatları yeni `Job` düzenine uymadığı
  için BC-22'de kaldırılmıştı; geçmişte durur.

## Testler

```bash
anchor build
cargo test --manifest-path tests/programs/Cargo.toml --test escrow --test escrow_lifecycle --test travel_rule --test claim --test finalize --test release_gate --test dispute --test dispute_gate --test mpp
```

Testler [`tests/programs/tests/`](../../tests/programs/tests/)'tedir: `escrow.rs`, `escrow_lifecycle.rs`,
`travel_rule.rs`, `claim.rs`, `finalize.rs`, `release_gate.rs`, `dispute.rs`, `dispute_gate.rs`, `mpp.rs`. Derlenmiş escrow, registry, policy ve verifier programlarını LiteSVM'de
çalıştırır. Agent kaydı, screening, kurum ve politika programların kendi instruction'larıyla, USDC SPL Token
programıyla kurulur. İspat kapısı testlerinin ispatları gerçek Groth16 ispatlarıdır.

CU (LiteSVM): `finalize_payment` gate'siz ~48 bin, uyumlu ispatla (record_release CPI dahil) ~74 bin;
`list_claim` ~18 bin, `buy_claim` ~23 bin (16 kardeşli en derin listede de), `cancel_claim` ~4 bin;
`raise_dispute` ~24 bin, `resolve_dispute` ~9 bin, `lapse_dispute` ~18 bin, `escalate_missing_proof` ~12 bin;
`execute_resolution` gate'siz ~66 bin, ispat kapısıyla ~80 bin; `create_fiat_job` ~32 bin, `finalize_fiat_payment`
~47 bin, `cancel_fiat_job` ~6,5 bin.

## Köken

Covenant `programs/covenant`'tan geçmişiyle taşındı (BC-04, [provenance](../../docs/provenance/BC-04.md));
BC-22 ile Square arayüzüne göre yeniden yazılmaya başlandı. Kaynak lisansı: [`LICENSE`](LICENSE).
