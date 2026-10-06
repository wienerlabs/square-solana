---
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-x402': minor
'@squaresdk/solana-api': minor
'@squaresdk/solana-db': minor
'@squaresdk/solana-web': minor
---

Geliştirici portalı: API anahtarları ve x402 ücretli uç noktalar (FE-22, API sözleşmesi v0.20.0, ADR 0023).

`@squaresdk/solana-types`: `X402Network`, `X402Endpoint`, `X402EndpointCreate`, `X402EndpointUpdate`,
`X402PaymentReport`, `X402Payment`, `X402UsageTotal`, `X402EndpointUsage` şemaları; `ApiKeyScope`'a `x402:serve`.

`@squaresdk/solana-sdk`: `SquareApi`'ye `listX402Endpoints`, `createX402Endpoint`, `getX402Endpoint`,
`updateX402Endpoint`, `deleteX402Endpoint`, `getX402EndpointUsage`, `recordX402Payment`.

`@squaresdk/solana-x402`: `paidRouteFromDefinition` portal tanımından ücretli route kurar ve uzlaştırılan
ödemeyi `onPayment` ile bildirir. Tanım önbellekte tutulur ve yenilenir; pasif tanım 503, silinen 404 alır.
`paidRoute`'a route başına `onSettled`; `createMemoryReplayStore` (tek süreçlik depo).

`@squaresdk/solana-api`: `/v1/x402/endpoints` uçları (tanım, kullanım, ödeme bildirimi); `x402:serve` kapsamı.
`@squaresdk/solana-db`: `x402_endpoints`, `x402_payments` tabloları ve `X402Network` enum'u.
`@squaresdk/solana-web`: `/app/developers` (cüzdanla API oturumu, anahtarlar, ücretli uç noktalar ve kullanım,
derlemesi testli SDK örnekleri).
