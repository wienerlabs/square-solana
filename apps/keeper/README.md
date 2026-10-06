# @squaresdk/solana-keeper

8 adımın 6.sı: challenge penceresi itirazsız biten job'ların permissionless `finalize_payment`'ı (BE-15).
Finalize'ı çağıran keeper ücretini alır (ADR 0013): `amount × keeper_fee_bps / 10 000`. Covenant'ın crank'i
GitHub Actions cron'uyla bir HTTP ucunu tetikliyordu ve ücretsizdi; burada ayrı, ücretli bir servis.

## Bir tur

1. **Adaylar** indexer'ın job aynasındandır: `Delivered`, `challenge_end <= now`, hesabı açık; challenge'ı en
   erken biten önce, en çok `KEEPER_BATCH_SIZE`.
2. **Zincir doğrulaması:** Her aday zincirden okunur: job, alacak, `ReleaseProof`, payee'nin screening kaydı.
   Job artık `Delivered` değilse (finalize edilmiş, ayna geride) atlanır, günlüğe yazılmaz.
3. **Ön kontrol** (`src/decide.ts`), `finalize_payment`'ın kuralları:
   - **Payee:** Alacak satıldıysa alıcı, değilse agent cüzdanı.
   - **Policy'li iş:** Bağlı ve tüketilmemiş ispat yoksa `proofRequired`. İspat payee, net ya da mint'te
     release'in hâline uymuyorsa `staleProof`.
   - **Screening:** Ödeme dalında payee'nin kaydı temiz ve taze değilse `screeningPending`.
4. **Priority fee:** Job'un yazılabilir hesaplarının son ücretlerinin `KEEPER_PRIORITY_FEE_PERCENTILE`
   yüzdeliği, en çok `KEEPER_MAX_COMPUTE_UNIT_PRICE`. Compute sınırı BC-28 profilindendir (SDK
   `flow.finalizePayment`).
5. **Kârlılık:**
   - **Maliyet:** Mesajın ücreti (`getFeeForMessage`: imza + priority fee) ile keeper'ın bu finalize'da açtığı
     hesapların rent'i:
     - `ValidationRecord` her zaman;
     - `AgentReputation` agent'ın ilk release'inde;
     - payee'nin ve kurumun token hesabı yoksa ikisi de (SDK akışı aynı tx'te açar, ödeyici keeper).
   - **Karşılaştırma:** Maliyet `KEEPER_MINT_UNITS_PER_SOL` ile settlement mint'ine çevrilir (yukarı yuvarlanır).
     Ücret maliyeti `KEEPER_MIN_MARGIN_BPS` payla aşmıyorsa `unprofitable`.
6. **Simülasyon:** İmzalı tx simüle edilir. Escrow'un bekleme hataları bekletme sebebi olur:
   - `ProofRequired` → `proofRequired`;
   - `StaleReleaseProof` → `staleProof`;
   - `Screening*` → `screeningPending`;
   - `ChallengePeriodNotExpired` → `challengeOpen`.

   Kalıcı/geçici ret ayrımı ve günlük sayaç tazeliği burada yeniden yazılmaz; kararı simülasyon verir. Diğer
   hatalar `failed` / `programError`.
7. **Gönderim:** Tx gönderilir (`submitted`). Onay `getSignatureStatuses` yoklamasıyla beklenir; websocket
   gerekmez.
   - Onaylanırsa `confirmed` ve keeper ücreti günlüğe yazılır.
   - Tx hatası `programError` olur.
   - Blockhash'in süresi dolarsa `rpcError` olur.

## Bekletme ve günlük

Her karar `keeper_actions`'a yazılır; API bunu `GET /v1/keeper/actions` ile sunar (BE-18).

- **Geri çekilme:** Bekletilen ya da başarısız job, aynı sebeple ardışık her denemede iki katı beklenerek
  (`KEEPER_BACKOFF_BASE_SECONDS`, en çok `KEEPER_BACKOFF_MAX_SECONDS`) yeniden denenir. Kayıt `nextAttemptAt`
  taşır, job o zamana kadar aday olmaz. `ProofRequired` bu yüzden sürekli denenmez.
- **Beklenen şey gelince:** Job beklemeden yeniden denenir.
  - İspat bekleyen job'a son denemeden sonra `ReleaseProof` indexlendiyse.
  - Screening bekleyen job'a payee'nin kaydı indexlendiyse.

  Bu yüzden ispat bağlanınca ödeme gecikmez.
- **Kârsız job** da günlüğe yazılır ve geri çekilmeyle yeniden değerlendirilir; priority fee ya da kur değişmiş
  olabilir.

## Çalıştırma

- **Önce:** Migration'lar ve `programs` tablosunun seed'i keeper'dan önce uygulanır
  ([apps/indexer](../indexer/README.md#çalıştırma)). Adaylar indexer'ın aynasından gelir.
- **Ortam:** Değişkenler [`.env.example`](.env.example)'dadır; varsayılan değer yoktur.
  - `KEEPER_SECRET_KEY` keeper cüzdanının 64 baytlık gizli anahtarıdır (base58). Log'da maskelenir, hata
    mesajına yazılmaz.
  - Kur (`KEEPER_MINT_UNITS_PER_SOL`) yapılandırmadır; fiyat oracle'ı kullanılmaz. İşleten taraf kuru günceller.
    Marj, kurun eskimesine karşı paydır.
- **Keeper'ın token hesabı:** Keeper ücreti kendi associated token hesabına alır. Hesap yoksa ilk finalize'dan
  önce bir kez açılır; bu, keeper'ın kendi hesabıdır, job'un maliyetine sayılmaz.
- **Tek örnek** çalışır: aynı job'a iki keeper aynı anda tx göndermesin.
- **İmaj:** `docker build -f apps/keeper/Dockerfile .` (repo kökünden).

| Uç | Port |
|---|---|
| `GET /health`, `GET /ready` (veritabanı, RPC) | `KEEPER_PORT` |
| `GET /metrics` | `KEEPER_METRICS_PORT` (iç ağ) |

**Metrikler:**
- `keeper_actions_total{outcome,reason}`
- `keeper_fees_earned_total`
- `keeper_balance_lamports`
- `keeper_last_round_timestamp_seconds`

**Alarmlar:**
- `keeper_low_balance`: Bakiye `KEEPER_ALERT_MIN_BALANCE_LAMPORTS`'un altında; işlem ücreti ve rent
  ödenemeyebilir.
- `keeper_stalled`: Son başarılı tur `KEEPER_ALERT_STALL_SECONDS` önce.
- `keeper_errors`: Başarısız finalize ve tur hataları pencerede eşiğin üstünde.

## Testler

`pnpm --filter @squaresdk/solana-keeper test`.
- **Karar mantığı:** finalize, beklet ve kârsız fixture girdilerle (`test/decide.test.ts`).
- **Uçtan uca tur** gerçek Postgres ve yerel fixture JSON-RPC sunucusuyla. Keeper gerçek web3.js ve Anchor
  istemcisiyle konuşur, hesaplar IDL coder'ıyla kodlanmıştır. Denenen durumlar:
  - aday seçimi;
  - kârlılık eşiği;
  - `ProofRequired`'ın geri çekilmesi ve ispat gelince yeniden denenmesi;
  - screening;
  - simülasyon, onay ve RPC hataları.
- **Gerçek programlarla finalize:** BE-36 (localnet).

## Kaynak

- **Covenant `app/app/api/cron/finalize`:** LGPL-2.1 `app/` dizinindedir ve taşınmaz
  ([BC-03 kaydı](../../docs/legal/relicensing/README.md)). O crank, veritabanındaki `Delivered` job'ları her
  5 dakikada bir HTTP ucu üzerinden finalize ediyordu. Ücret, kârlılık ya da ispat beklemesi yoktu.
- **`.github/workflows/covenant-crons.yml`:** Tetikleyicinin GitHub Actions cron'u. Yalnızca kapsam için okundu.

Kurallar Square'in `finalize_payment`'ından ve ADR 0013'ten; servis sıfırdan yazıldı.
