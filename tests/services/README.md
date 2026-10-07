# tests/services: servis entegrasyon testi (localnet)

**Issue:** BE-36 (#103) · **Paket:** `@squaresdk/solana-services-e2e` (private, yayımlanmaz) ·
**CI:** [`.github/workflows/services.yml`](../../.github/workflows/services.yml)

Dört Square programı `solana-test-validator`'da, Postgres ve S3 uyumlu depo konteynerlerde (Testcontainers) çalışır.
api, indexer, keeper, prover ve screener `apps/<servis>/dist/index.js`'ten gerçek süreçler olarak açılır. 8 adım ve
varyantlar smoke'un akışıyla koşar ([`runSmoke`](../smoke/src/smoke.ts): SDK ve `@squaresdk/solana-policy`);
screening, finalize ve bir ispat servislere bırakılır. Ardından servislerin etkileri denetlenir.

## Komut

```bash
anchor build                                                      # target/deploy/*.so
circuits/payment-compliance/scripts/ci-build.sh                    # release devresi (Linux); macOS: CIRCOM=<circom 2.2.3> node scripts/build.mjs
pnpm turbo run build --filter @squaresdk/solana-services-e2e...    # paket, smoke, beş servis ve bağımlılıkları
pnpm --filter @squaresdk/solana-services-e2e test:localnet         # validator, Postgres, depo, beş servis ve akış
pnpm --filter @squaresdk/solana-services-e2e test                  # zincirsiz birim testleri
```

Gerekenler: Agave CLI (`solana-test-validator`, sürüm `Anchor.toml [toolchain]`), Docker (Testcontainers:
`postgres:17-alpine`, `chrislusf/seaweedfs:4.48`), `openssl` ve derlenmiş release devresi. `test:localnet`
`SQUARE_LOCALNET=1` ile koşar; değişken yoksa test atlanır.

| Değişken | Varsayılan | |
|---|---|---|
| `SQUARE_PROGRAMS_DIR` | `target/deploy` | Derlenmiş programlar |
| `SQUARE_SERVICES_RPC_PORT` | `28899` | Validator RPC'si |
| `SQUARE_SERVICES_FAUCET_PORT` | `29900` | Validator faucet'i |
| `SQUARE_SERVICES_GOSSIP_PORT` | `28001` | Validator gossip'i |
| `SQUARE_SERVICES_DYNAMIC_PORT_RANGE` | `28100-28200` | Validator'ın dinamik portları |
| `SQUARE_SERVICES_LEDGER` | geçici dizin | Ledger |
| `SQUARE_SERVICES_LOG_DIR` | geçici dizin | Validator'ın ve servislerin günlükleri; verilirse silinmez (CI'da artefakt) |

Validator portları standart localnet portlarından (8899, 9900, 8001) ayrıdır; test smoke'un ve API'nin localnet
testleriyle aynı anda koşabilir. Servislerin HTTP ve metrik portları işletim sisteminin verdiği boş portlardır.
Test başarısız olursa günlüklerin son satırları yazdırılır ve günlük dizini silinmez.

## Kurulum

1. **Anahtarlar:** Rol anahtarları (smoke'un rolleri) ve işaretli taraf koşu için üretilir, repo dışında geçici
   dizindedir ve koşu bitince silinir.
2. **Altyapı:** Postgres (`@squaresdk/solana-db/testing`, migration'lar `prisma migrate deploy` ile), SeaweedFS
   (teslimat ve kanıt kovaları) ve validator aynı anda açılır.
3. **Zincir:** Smoke'un localnet adımları: airdrop (screener authority'ye de), 6 ondalıklı mint, `init` (config'ler,
   Square ALT'ı). Zincirdeki executable hash'leri `.so` dosyalarınınkiyle karşılaştırılır.
4. **Seed:** `programs` tablosu db paketinin seed'iyle yazılır (`prisma db seed`, `SQUARE_PROGRAM_ID_*`).
5. **OFAC:** İşaretli tarafın Solana adresini içeren sentetik SDN listesi yerel bir https sunucusundan verilir.
   Sertifika `openssl` ile koşu için üretilir. Screener ona `NODE_EXTRA_CA_CERTS` ile güvenir; servisin https
   kuralı değişmez.
6. **Servisler:** Ortamları [`src/env.ts`](src/env.ts)'tedir. Süreçlere yalnızca `PATH`, `HOME`, `TMPDIR` ve kendi
   değişkenleri verilir. Her servisin `/ready`'si 200 olana kadar beklenir. Açılırken çıkan servis, günlüğüyle hemen
   hata verir.
   - Keeper'ın cüzdanı smoke'un `keeper`'ıdır; screener authority smoke'un `screener`'ıdır.
   - Keeper kuru `KEEPER_MINT_UNITS_PER_SOL=1000000`'dur: localnet işinin ücreti (25 birim × 50 bps) açılan
     hesapların rent'ini karşılar, kârlılık eşiği finalize'ı durdurmaz.
   - İlk indexer'ın uzlaştırma aralığı bir gündür. Koşu boyunca uzlaştırma çalışmaz; aynalar yalnızca taramanın
     yazdığıdır.
7. **API:** Kurum cüzdanıyla oturum açılır (Ed25519 imzası), `prove` kapsamlı anahtar alınır.

## Denetimler

[`test/localnet.e2e.test.ts`](test/localnet.e2e.test.ts), sırayla:

| Test | Denetlenen |
|---|---|
| Servisler hazır | Beş servisin `/ready`'si 200: veritabanı, RPC, depo, OFAC listesi, registry yetkisi, prover kapasitesi |
| 8 adım ve varyantlar | `runSmoke`'un bütün zincir denetimleri (akış, ispat-ret, ispat-yok, fiat). Screening'ler screener'ın `POST /v1/screenings`'iyle yazılır. Finalize'ı keeper yapar; test keeper günlüğünü API'den (`GET /v1/keeper/actions`) okur. ispat-yok varyantının ispatı API'nin `POST /v1/prove` vekili ve prover servisinden, diğerleri süreç içinde (Groth16). Prover servisi tam bir ispat üretti |
| ScreeningFlagged | Screener SDN'deki cüzdanı zincire `Flagged` yazar. Cüzdanı bu olan agent'a açılan işin `fund_job`'ı `ScreeningFlagged` ile düşer; iş `Open` kalır, kurumun bakiyesi değişmez |
| Event'ler | Zincirdeki bütün kesinleşmiş ve başarılı Square tx'lerinin event'leri (`getSignaturesForAddress` ve tx logları, SDK'nın çözücüsü) `chain_events` ile birebir aynı: eksik ve fazla yok. API'nin job görünümleri: ana iş `Released` (payee alıcı, alacak `Settled`, `Verified`), ret `Refunded` (`Refused`), ispat-yok `Released`, fiat `Released`, işaretli iş `Open` |
| Keeper | Ana iş ve ret işi `confirmed`, keeper ücretiyle; tx'i keeper imzaladı. ispat-yok işinde ispat gelmeden önce `proofRequired` bekletmesi, sonra `confirmed`. Ret işinin `ReleaseRefused` event'i API'de. Fiat ve işaretli iş keeper'ın günlüğünde yok |
| Screener | Dört cüzdanın denetim kaydında tek `recorded` karar (üçü `clear`, işaretli `flagged`), imzalı. API'nin screening görünümü aynı durumda; `fresh` yalnızca temizlerde |
| Uzlaştırma | Indexer yeniden açılır (uzlaştırma aralığı 1 s). İlk uzlaştırma `indexer_reconcile_runs_total{result="clean"}`; `drift` ve `error` 0. On ayna tablonun `indexer_reconcile_drift`'i ve `indexer_reconcile_undecodable` 0 |

Birim testleri zincirsizdir: servis ortamları servislerin kendi `loadConfig`'inden geçer (`apps/*/dist/config.js`),
sentetik SDN listesi screener'ın OFAC okuyucusundan geçer. Ayrıca süreç yönetimi (hazırlık, açılışta çıkma, SIGKILL),
https sunucusu ve sertifika, API oturumu, Prometheus metinleri ve event karşılaştırması da sınanır. Zincire ve
konteynerlere bağlı dosyalar (`src/world.ts`, `src/chain.ts`, `src/storage.ts`) kapsam ölçümünün dışındadır ve
`test:localnet` koşusunda sınanır.

## Dosyalar

| Dosya | İçerik |
|---|---|
| [`src/world.ts`](src/world.ts) | Kurulum, servislerin açılması ve kapatılması, screener ve keeper yardımcıları, indexer'ın yeniden açılması |
| [`src/env.ts`](src/env.ts) | Beş servisin ortam değişkenleri |
| [`src/options.ts`](src/options.ts) | Koşu ayarları (portlar, dizinler) |
| [`src/processes.ts`](src/processes.ts) | Süreç, günlük, `/ready` bekleme, boş port |
| [`src/tls.ts`](src/tls.ts), [`src/sdn.ts`](src/sdn.ts) | Kendinden imzalı sertifika, https sunucusu, sentetik SDN listesi |
| [`src/storage.ts`](src/storage.ts) | SeaweedFS konteyneri ve kovalar |
| [`src/chain.ts`](src/chain.ts), [`src/events.ts`](src/events.ts) | Zincirdeki event'ler ve karşılaştırma |
| [`src/metrics.ts`](src/metrics.ts) | Prometheus metin biçimi |
| [`src/auth.ts`](src/auth.ts) | API oturumu ve kapsamlı anahtar |
