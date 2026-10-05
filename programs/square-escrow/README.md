# square_escrow

Akışın 3. ve 4. adımları: kurum bir registry agent'ına iş açar, fonlar; agent kabul eder ve teslim eder.
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

```
Open -(fund_job)-> Funded -(accept_job)-> Accepted -(submit_work)-> Delivered
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
- **Sonraki issue'lar:** finalize ve keeper ücreti BC-23, ispat kapısı BC-24, alacak piyasası BC-25,
  itibar ve validation kaydı BC-26, dispute akışı BC-32 ve BC-33, Travel Rule commitment'ı BC-34.
  Covenant'ın bu talimatları yeni `Job` düzenine uymadığı için kaldırıldı; geçmişte durur.

## Testler

```bash
anchor build
cargo test --manifest-path tests/programs/Cargo.toml --test escrow --test escrow_lifecycle
```

Testler [`tests/programs/tests/escrow.rs`](../../tests/programs/tests/escrow.rs) ve
[`escrow_lifecycle.rs`](../../tests/programs/tests/escrow_lifecycle.rs)'tedir. Derlenmiş escrow, registry ve
policy programlarını LiteSVM'de çalıştırır; agent kaydı, screening, kurum ve politika programların kendi
instruction'larıyla, USDC SPL Token programıyla kurulur.

## Köken

Covenant `programs/covenant`'tan geçmişiyle taşındı (BC-04, [provenance](../../docs/provenance/BC-04.md));
BC-22 ile Square arayüzüne göre yeniden yazılmaya başlandı. Kaynak lisansı: [`LICENSE`](LICENSE).
