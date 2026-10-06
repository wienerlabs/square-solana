# ADR 0018: x402 facilitator'ı: kendi facilitator'ımız, harici facilitator yapılandırmayla

- **Durum:** Kabul edildi
- **Issue:** BE-24 (#79)
- **Karar kaynağı:** BE-24 iş kalemi 3 ("Facilitator kararı: kendi ya da harici, ADR") ve Square (Arc)
  kapsamı, [analiz §4.2](../analysis/square-solana-analysis.md)
  "x402 v2 gateway (kendi facilitator'ı)" (2026-10-06)
- **Kapsam:** [`packages/x402`](../../packages/x402/) (`@squaresdk/solana-x402`) ve ücretli uç açan servisler
  (şimdilik [`apps/compliance-api`](../../apps/compliance-api/))

## Bağlam

x402'de facilitator iki iş yapar. İstemcinin kısmen imzaladığı ödeme işlemini doğrular (`/verify`), ücret
ödeyen olarak ikinci imzayı atıp zincire gönderir (`/settle`). Kaynaklarda iki yaklaşım vardı:

- Covenant ve Aperture harici facilitator kullanıyordu. Covenant'ın dış bağımlılıkları arasında
  "x402 facilitator" var ([§1.6](../analysis/square-solana-analysis.md)); Aperture
  `X402_FACILITATOR_URL` ile yapılandırıyordu ([§2.4](../analysis/square-solana-analysis.md)).
- Square (Arc) kapsamı "x402 v2 gateway (kendi facilitator'ı)" diyor
  ([§4.2](../analysis/square-solana-analysis.md)).

Resmi `@x402/svm` paketi exact şemasının facilitator tarafını da içerir (`@x402/svm/exact/facilitator`). Kendi
facilitator'ımız bu yüzden kendi doğrulama kodu gerektirmez.

## Değerlendirilen seçenekler

1. **Harici facilitator (HTTP).**
   - Artısı: ücret ödeyen cüzdan ve RPC işletimi sağlayıcıdadır.
   - Eksisi: ödemenin doğrulanması ve zincire yazılması üçüncü tarafın erişilebilirliğine ve koşullarına
     bağlıdır. Resmi istemcinin varsayılanı `https://x402.org/facilitator`'dır ve test ağları içindir.
     Mainnet facilitator'ları sağlayıcı hesabı ve API anahtarı ister.
2. **Kendi facilitator'ımız (süreç içi).**
   - Artısı: resmi exact facilitator şeması servisin içinde çalışır, üçüncü taraf yoktur. Doğrulama ve
     uzlaştırma servisin kendi RPC'si üzerinden yapılır.
   - Eksisi: ücret ödeyen bir sıcak cüzdan (yalnızca SOL) işletmek gerekir.

## Karar

1. Varsayılan kendi facilitator'ımızdır (`DEFAULT_FACILITATOR_MODE = 'self'`). Doğrulama ve uzlaştırma resmi
   `@x402/svm` exact facilitator şemasıyla, ücretli ucu açan servisin içinde yapılır.
2. Ücret ödeyen cüzdan:
   - yalnızca SOL tutar ve ödeme alıcısından (`payTo`) ayrıdır;
   - anahtarı servisin gizli ortam değişkenidir (compliance-api: `X402_FEE_PAYER_KEYPAIR`).
   - Resmi şema ücret ödeyenin işlemde token aktarmasını reddeder.
3. RPC adresi ağ başına açıkça verilir (`rpcUrls`). Herkese açık yerleşik RPC kullanılmaz.
4. Harici facilitator yapılandırmayla seçilir: `mode: 'remote'`, facilitator adresi ve isteğe bağlı bearer
   belirteci (compliance-api'de `X402_FACILITATOR_URL` ve belirteç değişkeni; README'ye bakın).
5. Birden çok servis tek bir ücret ödeyen cüzdanı paylaşacaksa kendi facilitator'ımız HTTP ile açılır
   (`createFacilitatorRouter`). Uç bearer belirteci olmadan çalışmaz; belirteç en az 32 karakterdir.
6. Ağ kimlikleri CAIP-2'dir:

   | Ağ | CAIP-2 | Kullanım |
   |---|---|---|
   | mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | üretim |
   | devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | demo ve test |

   v1 adları (`solana`, `solana-devnet`) yapılandırmada kabul edilir ve CAIP-2'ye çevrilir.
7. Ödeme varlığı Solana USDC'dir:
   - mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`;
   - devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

   `"$0.10"` biçimindeki fiyat ağın USDC'sine çevrilir. Başka bir mint açıkça verilir
   (`{ amount, asset }`; compliance-api `X402_PAYMENT_MINT`).
8. Ödeme yükleri facilitator'dan bağımsız olarak tek veritabanının `replay_guards` tablosunda tekrar
   korumasına alınır. Resmi facilitator'ın yinelenen ödeme önbelleği süreç içidir ve yeniden başlatmada
   kaybolur.

## Gerekçe

- Kendi facilitator'ın kaynağı Square (Arc) kapsamıdır. Kaynak bu tercihin gerekçesini yazmaz.
- Doğrulama kodunu resmi paketten almak BE-24'ün koşuludur ("resmi `@x402/*` üzerine, tek implementasyon");
  kendi facilitator'ımız bu koşulu bozmaz.
- Harici seçenek yapılandırmada kalır: test ağında ya da sağlayıcı tercih edilirse kod değişmez.

## Sonuçlar

- Uygulandı (BE-24): [`packages/x402`](../../packages/x402/):
  - `createFacilitatorClient`, `createSelfFacilitator`, `createFacilitatorRouter`;
  - `apps/compliance-api` ücretli raporu bu pakete delege eder.
- Ücret ödeyen cüzdanın SOL bakiyesi izlenmelidir; bakiye biterse uzlaştırma başarısız olur ve istek 402
  alır. Bakiye alarmı gözlemlenebilirlik kurallarına eklenmedi.
- Bekleyen uzlaştırma deposu (onayı zaman aşımına uğrayan işlem) resmi şemanın bellek içi varsayılanıdır.
  Kalıcı depo `scheme.pendingSettlementStore` ile verilebilir; şu an verilmiyor.

## Açık noktalar

- Ücretli ucun devnet'te gerçek ödemeyle açılması (BE-24 kabul kriteri) bu ortamda yapılmadı. Ağ erişimi ve
  fonlanmış devnet cüzdanları gerekir.
- Ücret ödeyen cüzdanın SOL bakiyesi için eşik alarmı ([BE-12] kuralları).

[BE-12]: https://github.com/wienerlabs/square-solana/issues/45
