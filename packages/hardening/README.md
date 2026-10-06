# @squaresdk/solana-hardening

Servislerin ortak koruma katmanı (BE-13). Indexer, API, keeper ve agent sunucuları (BE-14, BE-18, BE-15,
BE-17) dış dünyadan gelen isteği ve dışarıya giden isteği bu paketle korur.

| Modül | Ne verir |
|---|---|
| `ssrf` | `createSafeFetch({ allowHttp, allowPrivateAddresses, timeoutMs, maxBytes, maxRedirects })`: kullanıcının verdiği adrese (agent card URI'si, teslimat adresi, webhook hedefi) istek. Ayrıntı aşağıda. `assertSafeUrl` yalnızca sözdizimini, `isPublicAddress` tek bir IP'yi denetler |
| `idempotency` | `createIdempotency({ store, ttlSeconds }).run({ scope, key, request, handler })`: aynı `Idempotency-Key` ile tekrarlanan istekte işlem ikinci kez yapılmaz, ilk yanıt döner (`replayed: true`). Anahtar başka bir istekle kullanılırsa `mismatch`, ilk istek sürerken `in_progress`. 5xx yanıt ve hata kaydedilmez; istemci yeniden deneyebilir. Süreç istek ortasında düşerse anahtar `ttlSeconds` dolana kadar `in_progress` kalır; istemci yeni anahtarla yeniden gönderir |
| `rate-limit` | `createRateLimiter({ store, rule: { limit, windowSeconds } })`: anahtar başına sabit pencere, isteğe ağırlık (`cost`). `rateLimitHeaders` `RateLimit-Limit` / `-Remaining` / `-Reset` ve reddedilende `Retry-After`. `rateLimitMiddleware` Express uyumlu; depo hatasında istek geçirilmez |
| `rpc-failover` | `createFailoverFetch({ endpoints, timeoutMs, cooldownMs })`: ulaşılamayan, zaman aşımına uğrayan ya da 429 / 5xx dönen RPC ucu `cooldownMs` boyunca devre dışı kalır, istek sıradakine gider. JSON-RPC hatası (HTTP 200) failover sebebi değildir. web3.js'e `new Connection(endpoints[0], { fetch })` ile verilir; WebSocket abonelikleri kapsam dışı |
| `signed-action` | Cüzdan imzalı istekler. İstemci: `signAction`, `signedFetch({ signer, domain })`. Sunucu: `verifySignedAction({ headers, domain, method, path, body, maxAgeSeconds, clockSkewSeconds, replay })` imzalayan cüzdanı döner. Ayrıntı aşağıda |
| `webhook` | [Standard Webhooks](https://www.standardwebhooks.com) imzası. `signWebhook`, `verifyWebhook({ secrets, headers, payload, toleranceSeconds, replay, scope })`, `generateWebhookSecret`. Ayrıntı aşağıda |
| `secret-box` | `createSecretBox({ keys, activeKeyId })`: üçüncü taraf API anahtarları ve webhook sırları gibi değerlerin veritabanında AES-256-GCM ile şifreli tutulması. `parseSecretBoxKeys` ortamdaki anahtar halkasını okur. Ayrıntı aşağıda |
| `secure-compare` | `safeEqual(a, b)`: sırların sabit zamanlı karşılaştırması (uzunluk da sızmaz) |
| `stores` | Kalıcı durumun arayüzleri: `ReplayStore`, `RateLimitStore`, `IdempotencyStore`, `ExpiringStore` |

Postgres depoları ayrı giriş noktasındadır: `@squaresdk/solana-hardening/prisma` →
`createPrismaReplayStore`, `createPrismaRateLimitStore`, `createPrismaIdempotencyStore`. İstemci
`@squaresdk/solana-db`'nin `createDatabaseClient`'ıdır; tablolar `rate_limit_windows`,
`idempotency_records`, `replay_guards` ([veri modeli](../../docs/design/data-model.md)). Her işlem tek bir SQL
ifadesiyle atomiktir: servisin birden çok örneği aynı veritabanında sınırları ve tekrar korumalarını paylaşır.
Süresi dolan satırları `purgeExpired(now)` siler; servis bunu periyodik çağırır.

## SSRF

- Adres yalnızca `https` (`allowHttp` yalnızca geliştirmede), kullanıcı bilgisiz.
- Ad bağlantı anında çözülür; çözülen adreslerden biri bile herkese açık değilse istek reddedilir. Bağlanılan
  adres denetlenen adrestir (DNS rebinding ile denetimden sonra iç adrese geçilemez).
- Engellenen aralıklar: özel ağlar, döngü, yerel bağlantı (bulut meta veri ucu `169.254.169.254` dahil),
  CGNAT, belgeleme, çoklu yayın ve ayrılmış aralıklar; IPv6'da ULA, yerel bağlantı, NAT64, 6to4, Teredo.
  IPv4 eşlemeli IPv6 adresi IPv4 kurallarıyla denetlenir.
- Yönlendirmeler elle izlenir; her adımda aynı denetimler, sayı `maxRedirects` ile sınırlı.
- Toplam süre `timeoutMs`, yanıt gövdesi `maxBytes` ile sınırlı.
- `allowPrivateAddresses` yalnızca iç servis çağrıları ve testler içindir.

## İmzalı eylemler

Cüzdan isteğin kendisini imzalar; imzalanan mesaj cüzdanın gösterdiği okunabilir metindir:

```
<alan adı> wants you to sign a request with your Solana account:
<cüzdan>

Action: <YÖNTEM> <yol?sorgu>
Body SHA-256: <hex>
Nonce: <16 rastgele bayt, hex>
Issued At: <ISO 8601>
```

Başlıklar `x-square-wallet`, `x-square-signature` (base58 Ed25519), `x-square-nonce`, `x-square-issued-at`.
Sunucu alan adını kendi değeriyle kurar; imza başka bir servise, uç noktaya, gövdeye ya da ikinci kez
kullanılamaz. Nonce `signed-action:<alan adı>` kapsamında `maxAgeSeconds` boyunca tutulur.

## Webhook

- Başlıklar `webhook-id`, `webhook-timestamp` (Unix saniyesi), `webhook-signature: v1,<base64>`.
- İmza `HMAC-SHA256(sır, id.zaman.gövde)`; sır `whsec_<base64>`, en az 24 bayt.
- Alıcı gövdeyi ayrıştırmadan, alındığı haliyle verir.
- Denetim sırası:
  - zaman damgası `toleranceSeconds` içinde;
  - imza verilen sırlardan biriyle geçerli (sır döndürülürken eski ve yeni birlikte verilir);
  - teslimat kimliği `scope` içinde daha önce kabul edilmemiş (tekrar oynatma).
- Kimlik yalnızca imza geçtikten sonra kaydedilir: sahte istek gerçek bir kimliği tüketemez.

## Gizli değer kutusu

- Biçim `sq1.<anahtar kimliği>.<iv>.<şifreli metin + etiket>` (base64url). AES-256-GCM, her değerde yeni 12
  baytlık IV.
- Anahtarlar 32 rastgele bayttır, paroladan türetilmez. Ortamda `kimlik:base64,kimlik:base64`;
  üretmek için `openssl rand -base64 32`.
- Anahtar döndürme: yeni anahtar halkaya eklenip etkin yapılır, eskiler açmak için halkada kalır.
  `needsRotation(değer)` eski anahtarla şifrelenmiş değeri bildirir; servis onu yeniden şifreler.
- `aad` değeri bir bağlama (ör. kaydın kimliği) bağlar: başka bir kayda kopyalanan şifreli değer açılmaz.

## Kaynak

- **Covenant `app/lib`** (`ssrf`, `idempotency`, `rateLimit`, `rpc-failover`, `webhooks`, `secure-compare`,
  `wallet-sign`): LGPL-2.1 `app/` dizinindedir ve Square'e taşınmaz
  ([BC-03 kaydı](../../docs/legal/relicensing/README.md)). Modüller sıfırdan yazıldı; webhook tekrar koruması
  sravan27 kararı gereği clean-room, Standard Webhooks spesifikasyonundan.
- **AIP `src/lib/auth/{encrypt,signed-fetch}.ts`** yalnızca kapsam için okundu, kod alınmadı:
  - `encrypt.ts` anahtarı bir sırrın SHA-256'sından, yoksa escrow özel anahtarından türetiyordu ve anahtar
    döndürme yoktu. Burada rastgele 32 baytlık anahtar halkası, anahtar kimliği ve AAD var.
  - `signed-fetch.ts` oturum boyunca aynı imzayı gönderiyordu; imza isteğe ve gövdeye bağlı değildi. Burada
    her istek kendi imzasını, tek kullanımlık nonce'unu ve gövde özetini taşır.
- **Covenant `sdk/src/retry.ts`** (Apache-2.0; [BE-02 eşlemesi](../../docs/provenance/BE-02.md)): yerini
  `rpc-failover` aldı. Geçici hata aynı istekte sıradaki uca gider. Tek uçlu kurulumda 429'u web3.js
  kendisi bekleyerek yeniden dener.
