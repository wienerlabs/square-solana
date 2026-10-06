# @squaresdk/solana-x402

Square'in tek x402 implementasyonu (BE-24). Kaynaklardaki üç ayrı x402 kodunun
([analiz](../../docs/analysis/square-solana-analysis.md) §6, 17. satır; §7, 5. satır) yerini alır. Protokol, Solana
exact şeması, facilitator, Express ara katmanı ve ödeyen istemci resmi `@x402/*` 2.28.0 paketleridir:

- `@x402/core`
- `@x402/svm`
- `@x402/express`
- `@x402/fetch`

Paket kendi kripto ya da ödeme doğrulamasını yazmaz. Resmi parçaları Square'in yapılandırmasıyla birleştirir
ve kalıcı tekrar korumasını ve idempotent yanıtı ekler. Facilitator kararı:
[ADR 0018](../../docs/decisions/0018-x402-facilitator.md).

| Modül | Ne verir |
|---|---|
| `gateway` | `createX402Gateway({ facilitator, replay, idempotency, networks, rpcUrl, replayTtlSeconds, onEvent })` ve `gateway.paidRoute({ price, payTo, network, description, settle, onSettled })` (Express ara katmanı). İşleyici ödemeyi `getX402Payment(res)` ile okur; `onSettled` route'ta zincire yazılan her ödemeyi verir |
| `definition` | `paidRouteFromDefinition(gateway, kaynak, { onPayment, refreshSeconds, settle })`: Square geliştirici portalındaki tanımdan (`X402Endpoint`) ücretli route ve uzlaştırılan ödemenin bildirimi ([Portal tanımları](#portal-tanımları-fe-22)) |
| `client` | `createPayingFetch({ signer, networks, rpcUrl, spendControls })`: ödeyen `fetch`, cüzdan imzalayıcısı enjekte edilir; sunucu duyurduysa ödeme kimliği ekler (`paymentIdentifierExtension`). `readPaymentReceipt(response)`: `PAYMENT-RESPONSE` makbuzu |
| `facilitator` | `createFacilitatorClient({ mode: 'self', feePayer, rpcUrls })` (varsayılan) ya da `({ mode: 'remote', url, authToken })`, `createSelfFacilitator`, `DEFAULT_FACILITATOR_MODE` |
| `facilitator-http` | `createFacilitatorRouter({ facilitator, authToken })`: kendi facilitator'ımızı başka servislere x402 facilitator HTTP API'siyle açar (`POST /verify`, `POST /settle`, `GET /supported`; bearer belirteci zorunlu) |
| `idempotent` | `PaymentResponseStore` (hardening'in `IdempotencyStore`'uyla aynı), `IdempotencyOptions`: ödeme kimliğiyle kayıtlı yanıt ([aşağıda](#idempotent-yanıt)) |
| `replay` | `ReplayStore` (hardening'in arayüzüyle aynı), `paymentFingerprint(payload)`, `replayScope(network)`, `createMemoryReplayStore()` (tek süreçlik geliştirme deposu) |
| `networks` | CAIP-2 kimlikleri `SOLANA_MAINNET`, `SOLANA_DEVNET`, `SOLANA_TESTNET`. `toSolanaNetwork` v1 adını ve takma adı CAIP-2'ye çevirir. `usdcMint(network)` |

Paket yalnızca gerçek RPC'lerle çalışır. Testlerin Solana JSON-RPC fikstürü `test/solana-rpc.ts`'tedir ve
paketle yayınlanmaz.

## Kullanım

```ts
import { createPrismaIdempotencyStore, createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import { createFacilitatorClient, createX402Gateway, getX402Payment, SOLANA_MAINNET } from '@squaresdk/solana-x402';

const gateway = createX402Gateway({
  facilitator: createFacilitatorClient({ feePayer, rpcUrls: { [SOLANA_MAINNET]: process.env.SOLANA_RPC_URL! } }),
  replay: createPrismaReplayStore(db),
  idempotency: { store: createPrismaIdempotencyStore(db), ttlSeconds: 86_400 },
  networks: [SOLANA_MAINNET],
});

app.get(
  '/v1/report',
  gateway.paidRoute({ price: '$0.10', payTo: treasury, network: SOLANA_MAINNET, description: 'Rapor' }),
  (req, res) => res.json({ payer: getX402Payment(res)!.payer }),
);
```

```ts
import { createPayingFetch, readPaymentReceipt, SOLANA_MAINNET } from '@squaresdk/solana-x402';

const pay = createPayingFetch({ signer: agentWallet, networks: [SOLANA_MAINNET], rpcUrl });
const response = await pay('https://api.example/v1/report');
readPaymentReceipt(response); // { success, transaction, network, payer }
```

- **Fiyat:** `price` ya `"$0.10"` biçimindedir (ağın USDC'si, 6 ondalık) ya da
  `{ amount: '<taban birim>', asset: '<mint>' }`.
- **Harcama sınırı:** resmi istemcinin `spendControls`'udur. Varsayılan yalnızca tanınan stablecoin'leri ve
  ödeme başına $1'ı kabul eder. Başka bir mint `allowedAssets` ile açılır; mint başına taban birim tavanı
  verilebilir.

## Portal tanımları (FE-22)

Geliştirici ücretli uç noktasını Square geliştirici portalında (web `/app/developers`) tanımlar: yol, ad, fiyat,
mint, ağ, alıcı, açıklama, etkin / pasif. Ödemeyi kendi sunucusu ister; tanım ve kullanım Square API'sindedir.
Karar: [ADR 0023](../../docs/decisions/0023-x402-ucretli-uc-nokta-tanimlari.md). Square API'sinin kendi altında
geçit olması seçilmedi: facilitator ve ücret ödeyen cüzdan ADR 0018'deki gibi ücretli ucu açan servistedir.

```ts
const square = createApiClient({ baseUrl, auth: { apiKey: process.env.SQUARE_API_KEY! } }); // x402:serve
app.get(
  '/v1/report',
  paidRouteFromDefinition(
    gateway,
    async () => {
      const result = await square.getX402Endpoint(id);
      if (result.success) return result.data;
      if (result.error.code === 'not_found') return null;
      throw new Error(result.error.message);
    },
    { onPayment: (payment) => square.recordX402Payment(id, payment).then(() => undefined) },
  ),
  handler,
);
```

- **Route:** tanımdan `gateway.paidRoute` kurulur. Fiyat `{ amount, asset: mint }` olur; ağ, alıcı ve
  açıklama tanımdandır. Fiyat ya da alıcı değişince ara katman yeniden kurulur.
- **Yenileme:** kaynak fonksiyonsa tanım `refreshSeconds` (varsayılan 30) önbellekte tutulur. Portaldaki
  değişiklik en geç bu süre sonra uygulanır.
- **Pasif ve silinmiş tanım:** pasif tanım 503 (`x402_endpoint_disabled`), silinmiş tanım (kaynak `null`
  döner) 404 (`x402_endpoint_not_found`) alır. İkisinde de ödeme istenmez ve işleyici çalışmaz.
- **Tanım okunamazsa:** hiç okunamamışsa 503 (`x402_definition_unavailable`); okunduktan sonraki hatada son
  bilinen tanım kullanılır. Hata `onError`'a gider.
- **Bildirim:** uzlaştırılan her ödeme `onPayment(kayıt, tanım)` ile verilir. Kayıt API'nin
  `X402PaymentReport` gövdesidir: `fingerprint` (tekrar koruması kimliği), `transaction` (makbuzun işlem
  imzası), ağ, mint, tutar, ödeyen, alıcı, `settledAt`. Bildirim yanıtı bekletmez; hatası `onError`'a gider ve
  ödeme kullanımda sayılmaz.
- **Tip hizası:** API'nin `X402Endpoint`'i tanım, `X402PaymentRecord` API'nin gövdesi olarak doğrudan
  kullanılır (`test/definition.test.ts`, `@squaresdk/solana-types` ile derleme zamanında).

## Akış

1. Ödemesiz istek 402 alır. `PAYMENT-REQUIRED` başlığı (base64 JSON) x402 v2 gereksinimini taşır: `scheme:
   exact`, CAIP-2 ağ, mint, taban birim tutar, alıcı ve `extra.feePayer` (facilitator'ın ücret ödeyen
   cüzdanı).
2. İstemci SPL `TransferChecked` işlemini kurar. İşlemde hesaplama bütçesi ve memo talimatları da vardır.
   İstemci işlemi ödeyen olarak kısmen imzalar ve isteği `PAYMENT-SIGNATURE` ile tekrarlar.
3. Facilitator işlemi resmi exact şemasıyla doğrular:
   - talimat düzeni;
   - mint;
   - alıcının ATA'sı;
   - tutar;
   - ücret ödeyenin token aktarmaması;
   - simülasyon.
4. Tekrar koruması ödeme yükünü kaydeder.
5. Uzlaştırma iki biçimde olur:
   - `settle: 'after-handler'` (varsayılan, x402 `authorization` akışı): işleyici çalışır, yanıt 2xx/3xx ise
     facilitator işlemi ikinci imzacı olarak imzalar ve zincire gönderir. İşleyici 4xx/5xx dönerse ödeme
     alınmaz.
   - `settle: 'before-handler'` (`upfront` akışı): ödeme işleyiciden önce zincire yazılır. İşleyici işlem
     imzasını `getX402Payment(res).settlement.transaction` ile görür.
6. Yanıtın `PAYMENT-RESPONSE` başlığı makbuzdur: işlem imzası, ağ ve ödeyen.

## Tekrar koruması

- **Kimlik:** ödeme yükünün kimliği imzalanan işlem mesajının SHA-256'sıdır (`svm:<hex>`). Resmi
  facilitator'ın yinelenen ödeme önbelleği de aynı anahtarı kullanır.
  - Zarf alanları (`resource`, `extensions`) kimliği değiştirmez.
  - Ücret ödeyenin imza yuvası da değiştirmez: o yuvayı facilitator yeniden yazar.
- **Kayıt:** kimlik `x402:<CAIP-2 ağ>` kapsamında `ReplayStore.claim` ile kaydedilir. Kayıt zamanı akışa
  göre değişir:
  - `after-handler`: facilitator doğruladıktan sonra, işleyiciden önce. Sahte bir yük gerçek bir kimliği
    tüketemez.
  - `before-handler`: işleyiciden önceki uzlaştırmadan hemen önce.
- **Postgres deposu:** servislerde depo `createPrismaReplayStore(client)`'tır
  (`@squaresdk/solana-hardening/prisma`, `replay_guards` tablosu). Tek SQL ifadesi atomiktir. Kayıt süreç
  yeniden başlasa da geçerlidir ve servisin örnekleri arasında paylaşılır. Paket hardening'e çalışma anında
  bağlı değildir; arayüz yapısal olarak aynıdır.
- **Ret:**
  - `after-handler`: istek 402 alır, `PAYMENT-REQUIRED.error` `payment_replayed` olur.
  - `before-handler`: ret uzlaştırma makbuzundadır (`PAYMENT-RESPONSE`, `success: false`,
    `errorReason: payment_replayed`).
- **Depo hatası:** istek geçirilmez (`replay_guard_unavailable`).
- **Tek kullanım:** kullanılmış yük, işleyici hata dönse de ya da uzlaştırma başarısız olsa da yeniden
  kullanılamaz. İstemci yeni bir ödeme yükü kurar; resmi `@x402/fetch` bunu her istekte yapar.
- **Süre:** kayıt `replayTtlSeconds` (varsayılan 1 gün) tutulur. İşlemin blok hash'i yaklaşık 2 dakikada
  geçersizleşir; süre bol pay bırakır. Servis `purgeExpired(now)`'u periyodik çağırır.

## Idempotent yanıt

Yanıt yolda kaybolursa ödeyen ödemiş ama sonucu almamış olur. `idempotency` verilince bu durum kapanır:
- **Duyuru:** Route'lar 402 yanıtında resmi `payment-identifier` uzantısını (`@x402/extensions`) duyurur. Kimlik
  isteğe bağlıdır.
- **Kimlik:** `createPayingFetch` duyuru varsa her ödeme yüküne yeni bir kimlik koyar (`pay_…`).
- **Kayıt:** Uzlaştırılmış başarılı yanıt kimlikle saklanır: durum, `content-type`, `PAYMENT-RESPONSE` ve gövde.
  Depo `createPrismaIdempotencyStore(client)`'tır (`idempotency_records`). Kayıt yanıt gönderilmeden önce yazılır.
- **Tekrar:** Aynı kimlik aynı yük ve aynı istekle (yöntem, yol, ödeme kimliği) gelirse kayıtlı yanıt döner.
  İşleyici çalışmaz, ikinci kez ücret alınmaz (`idempotent_replay` olayı).
- **Ret:**
  - Kimlik başka bir yük ya da istekle gelirse 409 `payment_identifier_conflict`.
  - Aynı kimlikli istek sürerken gelen tekrar 409 `payment_in_progress`.
  - Biçimi geçersiz kimlik 400 `invalid_payment_identifier`.
- **Saklanmayan yanıt:** Uzlaştırılmayan yanıt (işleyici hatası, uzlaştırma hatası) saklanmaz. Yük yine de tekrar
  korumasına takılır; istemci yeni ödeme kurar ve ödeme alınmamıştır.
- **Depo hatası:** Kimlik ayrılamazsa istek geçirilmez (503 `idempotency_unavailable`). Kayıt yazılamazsa yanıt
  yine döner ve `idempotency_error` olayı üretilir.
- **Kimliksiz yük:** Olağan akıştan geçer.

## Eski implementasyonların kapsamı

Kaynaklar:
- **Covenant:** `wienerlabs/covenant@c29303695c75`: `app/lib/x402.ts`, `x402-server.ts`, `x402-payments.ts`.
- **Aperture:** `wienerlabs/aperture@2573802ad255`: `sdk/x402-adapter/src` ve compliance-api'nin ara katmanı.
  Ara katman bu depoya taşındı; artık bu pakete delege eder.
- **AIP:** `dr-wilson-empty/aip-beta@c33ae319ea46`: `src/lib/payment/x402.ts`.

| Yetenek | Covenant | Aperture | AIP | Bu paket |
|---|---|---|---|---|
| Ödeme gereksinimi (402) | Elle kurulan v2 `PaymentRequired`: CAIP-2 devnet, `exact`, USDC, `payTo`, `maxTimeoutSeconds` | `x402-adapter`: v1 başlık (`version: '1'`, `solana-devnet`, `token`, `amount`, `recipient`, `extra.aperture_*`) | v2 gereksinim, escrow alanlarıyla (`programId`, `authority`, `taskId`, `payee`) | `paidRoute`: resmi `x402HTTPResourceServer`, v2 `PAYMENT-REQUIRED`, CAIP-2 ağ, exact şeması, `extra.feePayer` |
| Ödemenin doğrulanması | İstemcinin gönderdiği işlemin imzası. `confirmed` işlem okunur: alıcıya ≥ tutar, doğru mint, işlem hatasız; şema alanları eşleşmeli. İsteğe bağlı facilitator `/verify` | Ara katman: imzanın zincirde ve hatasız olması (tutar, mint, alıcı denetlenmez). Adaptör: desteklenen mint, pozitif tutar, adres biçimi, ödeyenin bakiyesi | `initialize_escrow` işleminin discriminator'ı, tutarı, PDA'ları ve authority'si | Resmi exact facilitator şeması: talimat düzeni, mint, alıcı ATA, tutar, ücret ödeyen yalıtımı, simülasyon. Ödeyen bakiyesi simülasyonda denetlenir |
| Uzlaştırma | Yok: istemci önce kendisi öder | Yok: istemci önce kendisi öder | Sunucu imzalı işlemi gönderir (`skipPreflight`), onay en fazla 15 sn beklenir | Facilitator ücret ödeyen olarak imzalar, gönderir, onayı bekler. İşleyiciden sonra (varsayılan) ya da önce |
| Makbuz | Yok | Rapor gövdesinde `tx_signature` | Ayar gövdesinde `transaction` | `PAYMENT-RESPONSE` (`readPaymentReceipt`) |
| Tekrar koruması | Kalıcı `X402Payment` tablosu, işlem imzası birincil anahtar (C-032) | Yok: aynı imza sınırsız kullanılabilir | Yok | Postgres `replay_guards`, işlem mesajının SHA-256'sıyla; süreçler ve örnekler arası |
| Aynı ödemeyle tekrar istek | Aynı istek kayıtlı yanıtı alır, ikinci ücret yok (C-036); farklı istek reddedilir | — | — | [Idempotent yanıt](#idempotent-yanıt): resmi `payment-identifier` ve `idempotency_records`; farklı istek 409 |
| Sunucu hatasında ödeme | Ayrılan imza bırakılır, ödeyen aynı ödemeyle yeniden dener | — | — | `after-handler`'da işleyici hata dönerse ödeme alınmaz; yanıt saklanmaz |
| Ödeyen istemci | `sendX402Payment`: SOL aktarımı (devnet demo) | `X402PaymentInterceptor`: bakiye ve politika ispatı, sonra başlık | — | `createPayingFetch`: resmi `@x402/fetch` + exact istemci şeması, `spendControls`, ödeme kimliği |
| Facilitator | `X402_FACILITATOR_URL` verilirse `/verify` | `facilitator_url` yapılandırması | Yok (sunucu kendisi gönderir) | ADR 0018: varsayılan kendi facilitator'ımız, yapılandırmayla uzak; `createFacilitatorRouter` ile servisler arası paylaşım |
| Gelir mutabakatı | `reconcileAgentRevenue`: `AgentRevenue` ile doğrulanmış ödemeler (C-037) | — | — | Kapsam dışı (aşağıda) |

Kapsam dışı (başka issue'lar):
- **Covenant'ın gelir mutabakatı:** Hosted agent'ların gelir kaydına bağlıdır (BE-29). Ödemeler `settled` olayıyla
  ve `PAYMENT-RESPONSE` makbuzuyla izlenir.
- **AIP'nin escrow'u:** Escrow, %20 komisyon ve custodial bütçe Square'de zincirdeki escrow programıdır.
- **Aperture'ün politika ispatı:** İspat ödemeden önce istemcide alınıyordu (`aperture_proof_hash`). Square'de
  ödemenin uyum ispatı ayrı uçtan kaydedilir (`/api/v1/proofs`).

## Testler

`pnpm --filter @squaresdk/solana-x402 test`:
- **Facilitator:** Resmi exact facilitator. RPC'si testin Solana JSON-RPC fikstürüdür (`test/solana-rpc.ts`); paketle
  yayınlanmaz.
- **Cüzdanlar:** Anahtarlar çalışma anında üretilir.
- **Uçtan uca:** 402 → ödeme başlığıyla tekrar → 200 + makbuz; aynı başlıkla tekrar reddedilir.
  - Eşzamanlı tekrarlardan yalnızca biri geçer.
  - Uzak facilitator HTTP üzerinden.
  - Harcama sınırları.
- **Postgres:** Testcontainers ile (Docker gerekir).
  - `prisma-replay.test.ts`: Süreç yeniden başlatması yeni geçit, yeni facilitator ve yeni bağlantı havuzuyla
    canlandırılır. Facilitator'ın bellek içi önbelleği boştur; tekrarı yalnızca veritabanı kaydı durdurur. Aynı
    veritabanını paylaşan iki örnek de sınanır.
  - `idempotent.test.ts`: Kayıtlı yanıt, kimlik çakışması, saklanmayan yanıt, geçersiz kimlik, depo hataları.

- **Portal tanımı:** `definition.test.ts` tanımdan 402 gereksinimini, ödeme ve bildirimi, yenilemeyi (fiyat,
  pasif, silinmiş), tanım okunamazken davranışı ve API sözleşmesiyle tip hizasını sınar. Square API'siyle uçtan
  uca kabul `apps/api/test/x402.test.ts`'tedir.

Devnet koşusu (`test/devnet.e2e.test.ts`) yalnızca ortamla çalışır; anahtarlar repoda tutulmaz:

```bash
X402_E2E_PAYER=<devnet USDC'si olan keypair> X402_E2E_FEE_PAYER=<yalnızca SOL tutan keypair> \
X402_E2E_PAY_TO=<USDC hesabı açık alıcı> pnpm --filter @squaresdk/solana-x402 exec vitest run test/devnet.e2e.test.ts
```

Koşu iki kez 0,01 USDC öder ([deploy kaydı](../../docs/deploy/devnet.md#x402-be-24)):
- Ödeyen fetch ile ödeme yapılır; ardından aynı başlıkla kayıtlı yanıt alınır.
- Kimliksiz aynı başlıkla eşzamanlı iki istek gönderilir; ardından uzlaşmış ödeme yeniden denenir.
