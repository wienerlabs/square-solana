# square_escrow

Akışın 3, 4, 6 ve 8. adımları: kurum bir registry agent'ına iş açar, fonlar; agent kabul eder ve teslim eder;
challenge penceresi kapanınca herkes işi kapatır, ödeme ispat kapısından geçer.
Arayüz [program arayüzü §6 ve §10.4](../../docs/design/program-interface.md#104-square_escrow)'tedir;
IDL'i sözleşme IDL'iyle (`idl/square_escrow_contract.json`) aynıdır, henüz yazılmamış öğeler
[`scripts/ci/programs.mjs`](../../scripts/ci/programs.mjs)'te issue'larıyla listelidir.

| Talimat | Ne yapar |
|---|---|
| `init_config` | Tekil `EscrowConfig`'i açar; yalnızca programın yükseltme yetkilisi (`program` + `program_data`). Tek settlement mint'i (USDC), arbitrator seti (en fazla 7, `2 <= M <= N`), parametreler, okunan programların kimlikleri |
| `update_params` | Challenge sınırları, bond, keeper ücreti ve taslak parametreler; yalnızca `admin` |
| `create_job` | İşi ve boş vault'unu açar. Agent kaydı registry'ye ait, PDA'sı doğru ve `Active` olmalı; `wallet`'ı job'a kopyalanır. Opsiyonel `policy` + `policy_institution`: policy programına ait, etkin, imzacı kurumun güncel yetkilisi (multisig bağlıysa vault'u); commitment, günlük tavan ve sürüm job'a kopyalanır. Rent'i `payer` öder |
| `fund_job` | `amount`'u kurumun token hesabından vault'a kilitler. Kurumun ve `job.agent_wallet`'ın screening kaydı temiz ve taze olmalı; Travel Rule eşiği açıksa commitment bağlanmış olmalı |
| `accept_job` | Fonlanmış işi job'un agent cüzdanı kabul eder; kayıt `Active`, spec hash aynı, deadline geçmemiş |
| `submit_work` | Teslim: `work_hash`, `delivery_uri` (en fazla 128 bayt); challenge penceresi açılır (`challenge_end = now + challenge_period`). Kabul edilmiş iş `Inactive` kayıtla da teslim edilir, silinmiş kayıtla edilmez |
| `cancel_job` | Kurum `Open` / `Funded` işi, ya da deadline'ı geçmiş `Accepted` işi iptal eder: vault bakiyesi kuruma döner, vault kapanır, rent'i `job.rent_payer`'a |
| `sync_agent_wallet` | Registry'de cüzdanı değişen agent'ın kayıt sahibi, kapanmamış işi kaydın güncel cüzdanına taşır |
| `finalize_payment` | Permissionless: `challenge_end`'den sonra teslim edilmiş işi kapatır. Keeper ücreti (en çok 100 bps) her dalda çağırana. Policy'siz işte ve uyumlu ispatta net payee'ye (satılmış alacakta alıcıya), kesin retta kuruma; ispat yoksa ya da ret geçiciyse `ProofRequired`, bayatsa `StaleReleaseProof` ile bekler. Payee screening'i ödemeden önce. Policy'li işte verifier'ın `record_release` CPI'ı. İtibar agent kaydına, `ValidationRecord`, alacak `Settled` / `Defaulted`, vault kapanır |

```
Open -(fund_job)-> Funded -(accept_job)-> Accepted -(submit_work)-> Delivered
Delivered -(finalize_payment)-> Released | Refunded
Open | Funded | Accepted (deadline sonrası) -(cancel_job)-> Cancelled
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
- **Sonraki issue'lar:** alacak piyasası BC-25 (listeleme hesabı şimdilik sözleşmenin tipiyle okunup
  yazılır), dispute akışı BC-32 ve BC-33 (taslak `escalate_missing_proof` dahil), Travel Rule commitment'ı
  BC-34. Covenant'ın bu talimatları yeni `Job` düzenine uymadığı için kaldırıldı; geçmişte durur.

## Testler

```bash
anchor build
cargo test --manifest-path tests/programs/Cargo.toml --test escrow --test escrow_lifecycle --test finalize --test release_gate
```

Testler [`tests/programs/tests/`](../../tests/programs/tests/)'tedir: `escrow.rs`, `escrow_lifecycle.rs`,
`finalize.rs`, `release_gate.rs`. Derlenmiş escrow, registry, policy ve verifier programlarını LiteSVM'de
çalıştırır. Agent kaydı, screening, kurum ve politika programların kendi instruction'larıyla, USDC SPL Token
programıyla kurulur. İspat kapısı testlerinin ispatları gerçek Groth16 ispatlarıdır.

CU (LiteSVM): `finalize_payment` gate'siz ~48 bin, uyumlu ispatla (record_release CPI dahil) ~74 bin.

## Köken

Covenant `programs/covenant`'tan geçmişiyle taşındı (BC-04, [provenance](../../docs/provenance/BC-04.md));
BC-22 ile Square arayüzüne göre yeniden yazılmaya başlandı. Kaynak lisansı: [`LICENSE`](LICENSE).
