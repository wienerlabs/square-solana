# @squaresdk/solana-indexer

Square'in dört programının kesinleşmiş tx'lerinden event'leri ve ayna tabloları Postgres'e yazan servis
(BE-14). Tablolar ve ilkeler [veri modelindedir](../../docs/design/data-model.md); event'lerin tek kaynağı
[event şemasıdır](../../docs/design/events.md). API (BE-18) bu tablolardan
[okuma API'siyle](#okuma-apisi) okur.

## Akış

1. **RPC taraması (backfill + canlı):** Her program için `indexer_cursors`'taki imleçten yeni kesinleşmiş
   imzalar `getSignaturesForAddress` ile yeniden eskiye sayfalanır, sonra eskiden yeniye işlenir. İmleç yoksa
   programın bütün geçmişi taranır. İmleç, işlenen her imzayla aynı veritabanı transaction'ında ilerler.
2. **Helius webhook'u (isteğe bağlı):** `POST /webhooks/helius` (raw tx biçimi). Helius tx `confirmed`
   olunca gönderir ve aynı tx'i birden çok kez gönderebilir. Webhook bir bildirimdir: gövdeden yalnızca
   imzalar alınır, tx ve hesaplar kesinleşince RPC'den okunur. Bekleyen imzalar sınırlı bir kuyruktadır;
   kuyruk dolarsa ya da imza süre içinde kesinleşmezse bırakılır, tarama onu yine bulur. İstek, Helius'a
   verilen `Authorization` değeriyle doğrulanır; yapılandırmada değerin SHA-256'sı durur.
3. **Bir tx'in işlenmesi:**
   - Tx `finalized` commitment'la okunur. Başarısız tx durum değiştirmez; event'i yazılmaz.
   - Event'ler SDK'nın `decodeTransactionEvents`'iyle konumlarıyla (program, üst düzey talimat,
     talimattaki sıra) çözülür ve `chain_events`'e yazılır.
   - Tx'in yazılabilir hesaplarının hepsi (lookup table'dan yüklenenler dahil) aynı tx'in slot'undan eski
     olmayan bir durumda (`minContextSlot`) okunur. Square programlarının aynalanan hesapları ayna tablolara
     yazılır. Event hangi hesabın değiştiğini bildirir ama indexer event'e göre hesap seçmez: değişen her
     hesap tx'te yazılabilirdir. Bu yüzden `Log truncated` ile kesilmiş logda da ayna tablolar doğru kalır.
4. **Uzlaştırma:** Aynalanan her hesap tipi `getProgramAccounts` (discriminator filtresi) ile okunur,
   tabloyla karşılaştırılır ve sapmalar düzeltilir. Rapor `reconcile_drift` / `reconcile_clean` log'u ve
   `indexer_reconcile_drift{table}` metriğidir. İlk tam taramadan önce çalışmaz.

## İdempotency ve sıra

- Event `(imza, talimat, event)` anahtarıyla bir kez yazılır.
- Ayna satırı yalnızca yeni okumanın slot'u satırınkinden eski değilse güncellenir. Tarama, webhook ve
  uzlaştırma sırasız çalışsa da daha yeni durum ezilmez.
- Aynı tx birden çok programın taramasında ya da webhook'ta yeniden işlenebilir; sonuç aynıdır.
- Yazmalar tek yazıcıdandır: servis **tek örnek** çalışır.

## Hesapların durumu

| Durum | Ne olur |
|---|---|
| Hesap zincirde var | Satır yazılır; `slot` durumun okunduğu slot'tur |
| Hesap kapandı | `jobs` ve `claims`'te `closed_slot` yazılır, satır kalır. Aynı PDA yeniden açılırsa (yeni alacak listelemesi) satır yeniden açılır. Diğer tablolarda satır silinir |
| Job'un dispute'u | `disputes`, `Job.dispute`'un izdüşümüdür; `raisedAt == 0` ise satır yoktur |
| Sözleşme IDL'iyle çözülemeyen hesap | Ayna tabloya yazılmaz. `account_undecodable` uyarısı, `indexer_undecodable_accounts_total` metriği; uzlaştırmada sapmaya sayılmaz, `undecodable` olarak raporlanır. Örnek: devnet'te IDL'deki geçici adreslerde (BC-09) kaynak projelerin (Covenant, AIP, Aperture) dağıtımları duruyor; `Job` ve `AgentRecord` gibi aynı adlı hesapların discriminator'ı da aynı. |
| Sözleşmede olmayan event | Hata. Tx yazılmaz, tarama o imzada durur, `indexer_errors` alarmı çalar. Yayımlanmış event değişmez (event şeması §4); bu durum indexer'ın IDL'inin programın gerisinde olduğunu gösterir. |

## Okuma API'si

`@squaresdk/solana-indexer/read` → `createReadApi({ db, chainRef, registryProgramId })`. Fonksiyonlar API
sözleşmesinin okuma görünümlerini ve filtrelerini sunar. Görünüm, sözleşme şemasıyla doğrulanır. HTTP,
zarf ve yetki API'nindir (BE-18).

| Fonksiyon | Görünüm | Filtreler |
|---|---|---|
| `listJobs`, `getJob` | `JobView` (alacak, release ispatı, validation; satılmış alacakta `payee` alıcı) | `status`, `institution`, `agentRecord`, `policy` |
| `getInstitution` | `InstitutionView` | — |
| `listPolicies`, `getPolicy` | `PolicyView` (`policy_metas`'tan meta) | `institution`, `active` |
| `listAgents`, `getAgent` | `AgentView` (DID, `agent_cards`'tan kart, itibar) | `owner`, `status`, `skill` |
| `listClaims`, `getClaim` | `ClaimView` | `status`, `seller`, `buyer` |
| `listDisputes`, `getDispute` | `DisputeView` | `jobStatus` |
| `getScreening` | `ScreeningView` (`fresh`: `clear` ve süresi geçmemiş) | — |
| `listEvents` | `IndexedEvent` | `job`, `program`, `name`, `fromSlot` |

- **Sayfalama:** `page` 1'den, `limit` 1–200; sonuç `{ items, total, page, limit }`.
- **Sıralama:** Job'lar oluşturulma zamanına, dispute'lar açılma zamanına, diğer listeler son değişiklik
  slot'una göre yeniden eskiye; eşitlikte adres. Event'ler eskiden yeniye (slot, imza, talimat, event).
- **Kapanmış hesaplar:** Kapanmış job ve alacaklar dönmez.
- **Zaman:** `indexedAt` ve meta `updatedAt` Unix saniyesidir (sözleşmede i64 zamanlar saniye).
- **Kart:** `cardVerified` kartın son denetimde zincirdeki hash'le eşleşmesini ve o hash'in hâlâ zincirdeki
  değer olmasını ister.

## Çalıştırma

Migration'lar ve `programs` tablosunun seed'i indexer'dan önce db paketiyle uygulanır:

```bash
pnpm --filter @squaresdk/solana-db migrate:deploy
SQUARE_PROGRAM_ID_REGISTRY=… SQUARE_PROGRAM_ID_POLICY=… SQUARE_PROGRAM_ID_VERIFIER=… SQUARE_PROGRAM_ID_ESCROW=… \
  pnpm --filter @squaresdk/solana-db seed
```

Indexer program kimliklerini bu tablodan okur. Tablodaki IDL sürümü servisin IDL'iyle aynı değilse açılmaz.
Ortam değişkenleri [`.env.example`](.env.example)'dadır; varsayılan değer yoktur. İmaj:
`docker build -f apps/indexer/Dockerfile .` (repo kökünden).

| Uç | Port | |
|---|---|---|
| `GET /health` | `INDEXER_PORT` | Canlılık |
| `GET /ready` | `INDEXER_PORT` | Veritabanı ve RPC |
| `POST /webhooks/helius` | `INDEXER_PORT` | Yalnızca `INDEXER_WEBHOOK_AUTH_SHA256` verilince |
| `GET /metrics` | `INDEXER_METRICS_PORT` | İç ağ |

**Alarmlar:**
- `indexer_stalled`: Son başarılı taramanın üstünden `INDEXER_ALERT_STALL_SECONDS` geçti.
- `indexer_reconcile_drift`: Son uzlaştırmanın sapması `INDEXER_ALERT_DRIFT`'in üstünde.
- `indexer_errors`: İşleme hataları pencerede eşiğin üstünde.

**RPC:** Uçlar arasında failover `@squaresdk/solana-hardening`'dendir. Tek uçlu kurulumda 429'u web3.js
kendisi bekleyerek yeniden dener (bu bekleme web3.js'in kendi `console` satırıyla yazılır).

## Testler

`pnpm --filter @squaresdk/solana-indexer test`. Veritabanı testleri Postgres konteyneri açar (Docker
gerekir). Zincir, yerel bir JSON-RPC sunucusudur. Indexer bu sunucuyla gerçek web3.js istemcisiyle
konuşur; hesaplar ve event logları IDL coder'ıyla kodlanmıştır. Sözleşmedeki 40 event tipi fixture
log'larla çözülüp yazılır. Gerçek programlarla uçtan uca deneme BE-36'dadır (localnet).

## Kaynak

- **Covenant** `app/app/api/{helius,cron/reconcile}`: LGPL-2.1 `app/` dizinindedir ve Square'e taşınmaz
  ([BC-03 kaydı](../../docs/legal/relicensing/README.md)). Covenant event yayımlamıyordu; uzlaştırması
  programın son tx'lerini tarayıp log metninden `JobEvent` satırı kuruyordu.
- **Aperture** `services/compliance-api/src/watchers/solana-watcher.ts`: operatör cüzdanlarının token
  transferlerini Helius'un ayrıştırılmış tx API'siyle tarar; Square hesaplarını aynalamaz. Yalnızca kapsam
  için okundu.

Indexer, Square'in event şeması ve IDL'i üzerine sıfırdan yazıldı.
