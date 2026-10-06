# Runbook: servisler

**Issue:** BE-31 (#90). Servisler: indexer, API, keeper, prover, web. Hepsi aynı Postgres'i kullanır
([ADR 0009](../decisions/0009-tek-postgres-ve-prisma.md)). Barındırma Railway'dir
([ADR 0002](../decisions/0002-web-hosting-railway.md)); platform kurulumu BE-05 ve BE-37'de. Bu runbook platformdan
bağımsız sırayı ve denetimleri anlatır.

## Kurallar

- **Varsayılan değer yoktur.** Her servis ortamını açılışta doğrular; eksik ya da geçersiz değerde açılmaz. Değişkenler
  servisin `.env.example`'ındadır: [indexer](../../apps/indexer/.env.example), [API](../../apps/api/.env.example),
  [keeper](../../apps/keeper/.env.example), [prover](../../apps/prover/README.md#yapılandırma),
  [web](../../apps/web/README.md).
- **Sırlar secret store'dadır:** keeper'ın gizli anahtarı, Travel Rule anahtar halkası, API'nin prover anahtarı,
  S3 anahtarları, RPC anahtarları. Repoya ve loglara girmez.
- **Program kimlikleri tek yerdedir:** `programs` tablosu (seed). Ağ değerleri deploy kaydındadır
  ([devnet](../deploy/devnet.md#servislerin-devnet-değerleri)).
- **Keeper tek örnek çalışır.** İki keeper aynı job'a ya da aynı CCTP transferine tx gönderir.

## İlk kurulum

1. **Veritabanı:** Migration'lar, ardından program kimliklerinin seed'i. IDL sürümü servislerinkiyle aynı olmalı;
   değilse servisler açılmaz.

   ```bash
   DATABASE_URL=… pnpm --filter @squaresdk/solana-db migrate:deploy
   DATABASE_URL=… SQUARE_PROGRAM_ID_REGISTRY=… SQUARE_PROGRAM_ID_POLICY=… SQUARE_PROGRAM_ID_VERIFIER=… \
     SQUARE_PROGRAM_ID_ESCROW=… pnpm --filter @squaresdk/solana-db seed
   ```
2. **Indexer:** Açılınca programların bütün geçmişini tarar (backfill). `GET /ready` yeşil olmalı.
   `indexer_sync_lag_slots` düşmeli.
3. **Prover:** Artefaktların hash'i manifest'le aynı olmalı ([apps/prover](../../apps/prover/README.md#artefaktlar)).
4. **API:** `API_PROVER_URL` prover'ı, `API_LOOKUP_TABLE` Square ALT'ını, `API_CCTP_*` CCTP'yi gösterir. `GET /ready`
   veritabanı, RPC ve depo için yeşil olmalı.
5. **Keeper:** Cüzdanı fonlanır ([keeper runbook'u](keeper.md#cüzdan)). `KEEPER_CCTP_*` verilirse CCTP relayer'ı da
   çalışır.
6. **Web:** `SQUARE_*` değişkenleri; `SQUARE_API_URL` API'yi gösterir. API'nin `CORS_ORIGINS`'i ve `API_AUTH_DOMAIN`'i
   web'in adresiyle aynı olmalı.
7. **İzleme:** Prometheus kuralları ve Grafana panosu ([infra/monitoring](../../infra/monitoring/README.md)).
   `*_MetricsAbsent` alarmları susmalı.

## Denetim

| Servis | Hazır |
|---|---|
| Indexer | `/ready` 200; `indexer_sync_lag_slots` `INDEXER_ALERT_LAG_SLOTS`'un altında |
| API | `/ready` 200; `GET /openapi.json` sözleşmenin sürümünü gösterir (`info.version`) |
| Keeper | `/ready` 200; `keeper_last_round_timestamp_seconds` `KEEPER_POLL_INTERVAL_MS` aralığıyla ilerler |
| Prover | `/ready` 200 |
| Web | Ağ sayfası (`/app/network`): dört program "Upgradeable", config'ler okunuyor, ALT "Matches" |

## Yükseltme

- **Sıra:** Migration'lar önce uygulanır, sonra servisler yeni sürüme geçer. Migration'lar ileri yönlüdür. Bir
  migration satır taşıyamıyorsa durur (ör. `cctp_transfers`'ın V2 geçişi), servisleri yarım bırakmaz.
- **Sözleşme sürümü:** API ve SDK aynı sözleşme sürümünü kullanır (`API_CONTRACT_VERSION`,
  [api-sdk-contract.md](../design/api-sdk-contract.md)). Web ve entegrasyonlar API'den sonra yükseltilir.
- **Program upgrade'i:** IDL değişirse önce programlar yükseltilir ([upgrade runbook'u](upgrade.md)). Sonra seed
  yeni IDL sürümüyle yeniden çalıştırılır, ardından servisler yükseltilir.

## Geri alma

- **Servis:** Önceki imaja dönülür. Geri dönülen sürüm, uygulanmış migration'larla uyumlu olmalı. Uyumlu değilse
  migration geri alınmaz; düzeltme ileri yönlü yeni bir migration'la yapılır.
- **Keeper:** Durdurmak güvenlidir. Bekleyen finalize'lar ve CCTP transferleri bir sonraki açılışta zincirden
  yeniden okunur.
