# @squaresdk/solana-mock

FE-24 (#104). Web uygulamasının 8 adımı, gerçek servisler ve programlar hazır olmadan BE-35
sözleşmesine (v0.1.0, [`docs/design/api-sdk-contract.md`](../../docs/design/api-sdk-contract.md))
karşı geliştirebilmesi için:

| Parça | Ne yapar |
|---|---|
| `createMockApi()` | `SquareApi`'nin (`@squaresdk/solana-sdk`) 28 operasyonunun tamamını uygular. Okuma uçları senaryonun anlık görüntüsünden, yazma uçları (oturum, API anahtarı, politika meta'sı, kart barındırma, teslimat) bellekten döner |
| `createMockHandlers()` | [`docs/api/openapi.yaml`](../../docs/api/openapi.yaml) yolları için MSW handler'ları; gerçek HTTP istemcisi (BE-18) de mock'a konuşabilir |
| `buildWorld()` | 4 rol, 8 adım ve 4 varyant için deterministik fixture'lar |
| `createSquareApi()` | Ortam değişkeniyle mock / gerçek geçişi |

## Senaryo

Roller (`ROLES`): kurum, agent, alıcı, keeper. Adımlar (`STEPS`) analiz §4.2'deki "mandate'ten
ödemeye" akışıdır.

| Varyant (`VARIANTS`) | Dal | Durduğu adım | Sonuç |
|---|---|---|---|
| `happy` | — | 8 | `released`; ödeme alacağı satın alan alıcıya, itibar agent'a, validation `verified` |
| `proofPending` | bekletme | 6 | Kurum ispatı bağlamaz; keeper 6, 7 ve 8'de `proofRequired` ile bekler, iş `delivered` kalır |
| `releaseRefused` | ret | 8 | İspatın kararı `refused`; `refunded`, alacak `defaulted`, validation `refused`, `ReleaseRefused` event'i |
| `screeningFlagged` | ret | 3 | Agent cüzdanı `flagged`; iş `open` kalır, `fundJob` → `ScreeningFlagged` |

`prepareTx`, senaryoya göre programın vereceği hatayı döner: fonlamada `ScreeningFlagged` (6017),
challenge penceresi açıkken finalize'da `ChallengePeriodNotExpired`, ispat yokken `ProofRequired`
(6039). Hata kodları IDL'den okunur.

Durum yalnızca senaryo kontrolüyle değişir; `prepareTx` durumu ilerletmez:

```ts
import { createMockApi } from '@squaresdk/solana-mock';

const api = createMockApi({ variant: 'happy', step: 1 }); // varsayılan: happy, 8
await api.listJobs();      // adım 1: iş yok
api.scenario.next();       // adım 2
api.scenario.goTo(7);      // ispat bağlandı
api.scenario.setVariant('releaseRefused');
```

## Web uygulamasında kullanım

Mod, `SQUARE_API_MODE` ya da tarayıcıda `NEXT_PUBLIC_SQUARE_API_MODE` ile seçilir. **Varsayılan
`live`dır**; mock yalnızca açıkça istenince açılır ve `NODE_ENV=production`'da ayrıca
`SQUARE_ALLOW_MOCK_IN_PRODUCTION=1` ister. Covenant'ta settlement modunun varsayılanı "simulated"
olduğu için gerçek ağ hiç denenmemişti (analiz R14); bu varsayılan aynı hatayı önler.

```ts
import { createSquareApi } from '@squaresdk/solana-mock';

// Next.js tarayıcıda yalnızca literal `process.env.NEXT_PUBLIC_*` erişimini derleme zamanında gömer.
const api = createSquareApi({
  env: { NEXT_PUBLIC_SQUARE_API_MODE: process.env.NEXT_PUBLIC_SQUARE_API_MODE, NODE_ENV: process.env.NODE_ENV },
  client: { baseUrl: process.env.NEXT_PUBLIC_SQUARE_API_URL! },
});
```

HTTP düzeyinde mock gerekiyorsa (ör. gerçek istemciyi denemek için):

```ts
// Tarayıcı: önce `npx msw init apps/web/public` ile service worker dosyası üretilir.
import { setupWorker } from 'msw/browser';
import { createMockApi, createMockHandlers } from '@squaresdk/solana-mock';

await setupWorker(...createMockHandlers(createMockApi(), { baseUrl: 'http://localhost:3000' })).start();
```

```ts
// Node (testler): @squaresdk/solana-mock/node
import { setupMockServer } from '@squaresdk/solana-mock/node';

const server = setupMockServer();
server.listen({ onUnhandledRequest: 'error' });
```

## Güvenceler (`pnpm --filter @squaresdk/solana-mock test`, CI: `contract.yml`)

- `SquareApi`'yi tip düzeyinde uygular (`typecheck`) ve operasyon listesi `API_OPERATIONS` ile aynıdır.
- 4 varyant × 8 adımın her okuma ucu ve tüm yazma uçları `@squaresdk/solana-types`'ın zod
  şemalarından geçer (BC-44 IDL'inden üretilen hesap ve event şemaları dahil).
- Handler tablosu OpenAPI'deki (yöntem, yol, operationId) üçlüleriyle birebir aynıdır; istekler
  gerçek `fetch` ile denenir.

## Sınırlar

- Program ID'leri, adresler ve imzalar sahtedir (`mockAddress`); BC-09'un program ID'leri değildir.
  Agent'ın DID'i bu yüzden sahte bir registry ID'si taşır (BC-14 §9.2 v1 program ID'sinin
  kullanılmasını yasaklar).
- Fixture'lardaki `agentCardHash` örnek bir değerdir; `cardVerified: true` varsayımdır.
- Zincir istemcisi (`SquareClient` / `SquareFlow`: imzalama ve gönderme) taklit edilmez. Mock modda
  akış `scenario` ile ilerletilir; gerçek imzalama yolu FE-13'te devnet'e karşı doğrulanır.
