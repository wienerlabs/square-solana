# @squaresdk/solana-x402

Square'in tek x402 implementasyonu (BE-24). Kaynaklardaki üç ayrı x402 kodunun
([analiz](../../docs/analysis/square-solana-analysis.md) §6, 17. satır; §7, 5. satır) yerini alır. Protokol, Solana
exact şeması, facilitator, Express ara katmanı ve ödeyen istemci resmi `@x402/*` 2.28.0 paketleridir:

- `@x402/core`
- `@x402/svm`
- `@x402/express`
- `@x402/fetch`

Paket kendi kripto ya da ödeme doğrulamasını yazmaz. Resmi parçaları Square'in yapılandırmasıyla birleştirir
ve kalıcı tekrar korumasını ekler. Facilitator kararı:
[ADR 0018](../../docs/decisions/0018-x402-facilitator.md).

| Modül | Ne verir |
|---|---|
| `gateway` | `createX402Gateway({ facilitator, replay, networks, rpcUrl, replayTtlSeconds, onEvent })` ve `gateway.paidRoute({ price, payTo, network, description, settle })` (Express ara katmanı). İşleyici ödemeyi `getX402Payment(res)` ile okur |
| `client` | `createPayingFetch({ signer, networks, rpcUrl, spendControls })`: ödeyen `fetch`, cüzdan imzalayıcısı enjekte edilir. `readPaymentReceipt(response)`: `PAYMENT-RESPONSE` makbuzu |
| `facilitator` | `createFacilitatorClient({ mode: 'self', feePayer, rpcUrls })` (varsayılan) ya da `({ mode: 'remote', url, authToken })`, `createSelfFacilitator`, `DEFAULT_FACILITATOR_MODE` |
| `facilitator-http` | `createFacilitatorRouter({ facilitator, authToken })`: kendi facilitator'ımızı başka servislere x402 facilitator HTTP API'siyle açar (`POST /verify`, `POST /settle`, `GET /supported`; bearer belirteci zorunlu) |
| `replay` | `ReplayStore` (hardening'in arayüzüyle aynı), `paymentFingerprint(payload)`, `replayScope(network)` |
| `networks` | CAIP-2 kimlikleri `SOLANA_MAINNET`, `SOLANA_DEVNET`, `SOLANA_TESTNET`. `toSolanaNetwork` v1 adını ve takma adı CAIP-2'ye çevirir. `usdcMint(network)` |

`@squaresdk/solana-x402/testing`: `startFakeSolanaRpc()` testler için sahte Solana JSON-RPC'sidir. Ödeyen
istemcinin ve facilitator'ın çağırdığı yöntemleri yanıtlar: mint hesabı, blok hash'i, simülasyon, gönderme,
onay. Servisler kendi ücretli route testlerinde kullanır.

## Kullanım

```ts
import { createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import { createFacilitatorClient, createX402Gateway, getX402Payment, SOLANA_MAINNET } from '@squaresdk/solana-x402';

const gateway = createX402Gateway({
  facilitator: createFacilitatorClient({ feePayer, rpcUrls: { [SOLANA_MAINNET]: process.env.SOLANA_RPC_URL! } }),
  replay: createPrismaReplayStore(db),
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

## Eski implementasyonların kapsamı

Covenant ve AIP kaynakları bu depoda yok. Kapsamları [analizden](../../docs/analysis/square-solana-analysis.md)
alındı: §1.3 ve §1.6 (Covenant), §2.4 ve §2.6 (Aperture), §3.1 ve §3.3 (AIP).
Aperture'ün sunucu tarafı `apps/compliance-api/src/middleware/x402.ts`'teydi; o dosya artık bu pakete delege
eder.

| Yetenek | Covenant (resmi `@x402/core\|fetch\|next\|svm` ^2.10) | Aperture (`@aperture/x402-adapter`, compliance-api ara katmanı) | AIP (`lib/payment/x402.ts`, `@x402/core` ^2.8 tipleri) | Bu paket |
|---|---|---|---|---|
| Ödeme gereksinimi (402) | `@x402/next` ile v2 402 | 402 JSON gövdesinde `paymentRequirement`: `version: '1'`, ağ `solana` / `solana-devnet`, `token`, `amount`, `recipient` | A2A görevi için 402 teklifi (`task/quote`) | `paidRoute`: resmi `x402HTTPResourceServer`, v2 `PAYMENT-REQUIRED`, CAIP-2 ağ, exact şeması, `extra.feePayer`. Tarayıcıya temel ödeme sayfası |
| Ödeme başlığının doğrulanması | facilitator `/verify` | `x-402-payment`: base64 JSON, `txSignature`, `payer`, isteğe bağlı `zkProofHash`. Yalnızca işlemin zincirde olduğu ve hatasız olduğu denetlenir; tutar, mint ve alıcı denetlenmez, `payer` doğrulanmaz | özel doğrulama | resmi exact facilitator şeması: talimat düzeni, mint, alıcı ATA, tutar, ücret ödeyen yalıtımı, simülasyon. Uyuşmayan gereksinim `No matching payment requirements` |
| Uzlaştırma (settle) | facilitator `/settle` | yok: istemci işlemi kendisi gönderir, sunucu yalnızca okur | `payment/settle`, escrow | facilitator ücret ödeyen olarak imzalar ve gönderir. İşleyiciden sonra (varsayılan) ya da önce. Facilitator kendi (varsayılan) ya da uzak |
| Makbuz başlığı | `PAYMENT-RESPONSE` | yok; rapor gövdesinde `tx_signature` | (analizde yok) | `PAYMENT-RESPONSE` (`readPaymentReceipt`). İşleyiciden önce uzlaştırmada işlem imzası işleyicide de var |
| Ödeyen istemci | `@x402/fetch` | `x402-adapter` interceptor, `@aperture/agent` `x402-payer` | custodial agent bütçesi (`agent-budget`) | `createPayingFetch`: resmi `@x402/fetch` + exact istemci şeması. Cüzdan imzalayıcısı (`TransactionSigner`) enjekte edilir; `spendControls` |
| Tekrar koruması | (analizde yok) | yok: aynı `txSignature` sınırsız kullanılabilir | (analizde yok) | Postgres `replay_guards`, süreçler ve örnekler arası; resmi facilitator'ın süreç içi önbelleğine ek |
| Facilitator | harici facilitator | `X402_FACILITATOR_URL` | — | ADR 0018: varsayılan kendi facilitator'ımız, yapılandırmayla uzak; `createFacilitatorRouter` ile servisler arası paylaşım |

Kapsam dışı (başka issue'lar):

- AIP'nin escrow'u, %20 komisyonu ve custodial bütçesi Square'de zincirdeki escrow programıdır.
- Covenant'ın Next.js ara katmanı (`@x402/next`) burada yok. Square API'si Express'tir; web uygulaması
  ücretli uç açarsa resmi `@x402/next` aynı facilitator ve tekrar deposuyla kullanılır.
- Aperture'ün `zkProofHash` alanı x402 v2'de yok. Ödemenin uyum ispatı ayrı uçtan
  (`/api/v1/proofs`) kaydedilir.

## Testler

Testler ağ olmadan çalışır:

- **Facilitator:** resmi exact facilitator. RPC'si `startFakeSolanaRpc`'dir.
- **Cüzdanlar:** anahtarlar çalışma anında üretilir.
- **Uçtan uca:** 402 → ödeme başlığıyla tekrar → 200 + makbuz; aynı başlıkla tekrar → reddedilir.
  - Eşzamanlı tekrarlardan yalnızca biri geçer.
  - Uzak facilitator HTTP üzerinden.
  - Harcama sınırları.
- **Postgres:** `prisma-replay.test.ts` Testcontainers ile çalışır (Docker gerekir).
  - Süreç yeniden başlatması yeni geçit, yeni facilitator ve yeni bağlantı havuzuyla canlandırılır.
    Facilitator'ın bellek içi önbelleği boştur; tekrarı yalnızca veritabanı kaydı durdurur.
  - Aynı veritabanını paylaşan iki örnek de sınanır.

Kalan: ücretli uç devnet'te gerçek ödemeyle açılmadı (bu ortamda devnet erişimi yok).
