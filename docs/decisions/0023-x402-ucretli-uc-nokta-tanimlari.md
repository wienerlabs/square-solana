# ADR 0023: x402 ücretli uç nokta tanımları: tanım Square API'sinde, ödeme geliştiricinin sunucusunda

- **Durum:** Kabul edildi
- **Issue:** FE-22 (#86)
- **Karar kaynağı:** FE-22 iş kalemi 2 ("x402 ücretli uç nokta tanımları ve kullanım") ve kabul kriteri ("ücretli
  uç nokta yönetimi çalışıyor"); [ADR 0018](0018-x402-facilitator.md) (2026-10-06)
- **Kapsam:** [`packages/x402`](../../packages/x402/) (`paidRouteFromDefinition`), [`apps/api`](../../apps/api/)
  (`/v1/x402/endpoints`), [`apps/web`](../../apps/web/) (`/app/developers`), `db` (`x402_endpoints`,
  `x402_payments`)

## Bağlam

FE-22 harici geliştiriciye self-servis portal ister: API anahtarları, kendi x402 ücretli uç noktalarının
tanımları (yol, fiyat, mint, ağ, alıcı, açıklama, etkin / pasif) ve kullanımları (çağrı sayısı, tahsil edilen
tutar, son ödemeler). Tanımlanan uç noktanın gerçekten ödeme istemesi gerekir.

ADR 0018'e göre doğrulama ve uzlaştırmayı ücretli ucu açan servisin içindeki facilitator yapar. Ücret ödeyen
cüzdan o servisin gizli değişkenidir ve ödeme alıcısından (`payTo`) ayrıdır. Tekrar koruması aynı servisin
`ReplayStore`'udur.

## Değerlendirilen seçenekler

1. **Square API'si geçit olur.** Tanımlı uç noktaları kendi altında sunar (ör. `/x/{id}/*`) ve ödemeden sonra
   isteği geliştiricinin adresine iletir.
   - Artısı: kullanım Square'in veritabanına doğrudan yazılır.
   - Eksisi: Square'in facilitator'ı ve ücret ödeyen cüzdanı üçüncü tarafların ödemelerini uzlaştırır; Square
     ödeme ve yanıt yoluna girer.
   - Eksisi: geliştiricinin verdiği adrese sunucudan istek atılır (SSRF yüzeyi); yanıt ara belleğe alınır.
2. **Geliştiricinin sunucusu ödeme ister; tanım ve kullanım Square API'sindedir.** Sunucu tanımı API'den okur ve
   `paidRoute`'u ondan kurar. Uzlaştırdığı her ödemeyi API'ye bildirir.
   - Artısı: ADR 0018'in modeli değişmez: facilitator, ücret ödeyen cüzdan ve tekrar koruması ücretli ucu açan
     servistedir.
   - Eksisi: kullanım geliştiricinin bildirimidir; Square ödemeyi kendisi görmez.

## Karar

1. Tanım Square API'sinde durur ve cüzdana aittir (`X402Endpoint`; `x402_endpoints`, yol cüzdan başına tekil).
   Oluşturma, düzenleme ve silme oturumla yapılır (`createX402Endpoint`, `updateX402Endpoint`,
   `deleteX402Endpoint`).
2. Ödemeyi geliştiricinin sunucusu ister: `@squaresdk/solana-x402` `paidRouteFromDefinition(gateway, kaynak)`
   tanımdan `gateway.paidRoute` kurar.
   - Fiyat `{ amount, asset: mint }` olur; ağ, alıcı ve açıklama tanımdandır.
   - Kaynak fonksiyonsa tanım 30 saniye (`refreshSeconds`) önbellekte tutulur.
   - Pasif tanım 503 (`x402_endpoint_disabled`) alır, silinmiş tanım 404 alır. İki durumda da ödeme istenmez ve
     işleyici çalışmaz.
   - Tanım hiç okunamamışsa 503 döner; okunduktan sonraki hatada son bilinen tanım kullanılır.
3. Facilitator, ücret ödeyen cüzdan ve tekrar deposu ADR 0018'deki gibi geliştiricinin sunucusundadır. Square
   ödeme yolunda değildir.
4. Sunucu `x402:serve` kapsamlı API anahtarıyla tanımı okur (`getX402Endpoint`) ve uzlaştırılan her ödemeyi
   bildirir (`recordX402Payment`; `paidRouteFromDefinition` `onPayment`, gateway'in route başına `onSettled`'i).
5. Ödeme kaydı (`x402_payments`) x402 paketinin kayıtlarıyla ilişkilidir:
   - `fingerprint` ödeme yükünün tekrar koruması kimliğidir (`paymentFingerprint`; `ReplayStore`'daki
     `(x402:<ağ>, kimlik)`);
   - `transaction` uzlaştırma makbuzunun (`PAYMENT-RESPONSE`) işlem imzasıdır.
   - İkisi de ağ başına tekildir: aynı ödeme iki kez sayılmaz. Aynı bildirimin tekrarı ilk kaydı döner, başka
     tanıma ya da farklı işlemle bildirimi 409 alır.
6. Bildirilen ödemenin ağı, mint'i ve alıcısı tanımınkiyle aynı olmalıdır (400). Tutar bildirildiği gibi
   kaydedilir, çünkü fiyat sonradan değişmiş olabilir.
7. Kullanım (`getX402EndpointUsage`) ödemeli çağrı sayısı, ağ ve mint başına toplam, son ödeme zamanı ve son 20
   ödemedir.

## Gerekçe

- Kaynak (FE-22) iki seçenekten birini seçmez. Seçim ADR 0018'le tutarlılıktır: facilitator ve ücret ödeyen
  cüzdan "ücretli ucu açan servisin içinde"dir, geçit seçeneği bunu Square'e taşırdı.
- `@squaresdk/solana-x402` Express ara katmanı ve ödeyen istemci olarak tasarlandı; servis kendi route'una
  `paidRoute` ekler. Tanımdan route kurmak bu tasarıma yalnızca bir yardımcı ekler. Geçit seçeneği ise pakete
  vekil (proxy) davranışı eklerdi.

## Sonuçlar

- Uygulandı (FE-22):
  - `packages/x402/src/definition.ts`, `createMemoryReplayStore`, `paidRoute`'un `onSettled`'i;
  - `apps/api/src/x402.ts`, `apps/api/src/routes/x402.ts` (7 operasyon) ve `x402:serve` kapsamı;
  - migration `20261006150000_x402_endpoints`;
  - `apps/web` `/app/developers`.
- Kabul testi `apps/api/test/x402.test.ts`'tedir:
  - tanım oluşturulur, ödemesiz istek 402 alır, ödemeli istek 200 alır, kullanım sayacı artar;
  - pasifleştirme 503, silme 404 verir.
  - Ödeme resmi exact şemasıyla kurulur ve `startFakeSolanaRpc` üzerinden uzlaştırılır.
- Kullanım geliştiricinin sunucusunun bildirimidir. Bildirim başarısız olursa (API'ye ulaşılamazsa) o ödeme
  sayılmaz; `onError` çağrılır, yanıt etkilenmez.
- Birden çok örnekli sunucuda paylaşılan, kalıcı bir `ReplayStore` gerekir. `createMemoryReplayStore` tek
  süreçlik geliştirme deposudur.

## Açık noktalar

- Bildirilen işlemin zincirde doğrulanması (alıcı ATA'sına tutarın gittiği) yapılmıyor. Indexer ya da API bunu
  `transaction` üzerinden ekleyebilir.
- Başarısız bildirimlerin yeniden denenmesi (kalıcı kuyruk) geliştiricinin sunucusuna bırakıldı.
- Devnet'te gerçek ödemeyle deneme bu ortamda yapılmadı (ADR 0018'in açık noktasıyla aynı).
