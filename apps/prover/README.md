# apps/prover

Square release devresi ([`circuits/payment-compliance`](../../circuits/payment-compliance/),
[release-circuit.md](../../docs/design/release-circuit.md)) için Groth16 prover servisi (snarkjs).
Akışın 7. adımında kurumun yerine ispat üretir; çıktı `programs/square-verifier`'ın
`set_compliance_proof` talimatının beklediği groth16-solana bayt düzenindedir. Aperture
`prover-service`'ten geçmişiyle taşındı (BE-02), yeni devreye BE-11 ile uyarlandı.

## Güven sınırı

Witness politikanın kendisidir: limitler, engelli adresler, kategoriler, salt'lar. **Bu servisi işleten
taraf politikayı görür.** Politikasını kimseye göstermek istemeyen kurum ya kendi prover'ını çalıştırır
ya da `@squaresdk/solana-policy`'nin `createLocalProver`'ı ile ispatı kendi makinesinde üretir
([api-sdk-contract.md](../../docs/design/api-sdk-contract.md) §5). Servis witness'ı saklamaz ve log'a
yazmaz; log'da yalnızca istek kimliği, sonuç, süre ve ret kodu (public sinyal) bulunur.

## Uç noktalar

| Yöntem | Yol | Açıklama |
|---|---|---|
| POST | `/v1/prove` | `x-api-key` ister. Gövde `ProveRequest`, yanıt `ProveResponse` zarfı (`@squaresdk/solana-types`); API sözleşmesindeki `POST /v1/prove` ile aynı |
| GET | `/health` | Süreç sağlığı (`Health`, zarfsız) |
| GET | `/ready` | Kapasite varsa 200, kuyruk doluysa 503 (`Health`, zarfsız) |
| GET | `/openapi.json` | Servisin OpenAPI 3.1 belgesi (şemalar zod'dan üretilir) |
| GET | `/metrics` | Prometheus metrikleri; **ayrı portta** (`PROVER_METRICS_PORT`), yalnızca iç ağdan erişilmeli |

`/v1/prove` hata kodları:

| HTTP | `error.code` | Ne zaman |
|---|---|---|
| 400 | `invalid_input` | Gövde şemaya uymuyor; witness değeri kanonik ondalık alan elemanı değil; witness devreyi sağlamıyor (eksik / fazla sinyal, aralık denetimi) |
| 401 | `unauthorized` | `x-api-key` yok ya da kayıtlı değil |
| 409 | `conflict` | `artifactVersion` yüklü zkey'in SHA-256'sı değil; `details.expected` doğru sürümü verir |
| 503 | `prover_unavailable` | Eşzamanlılık sınırı ve kuyruk dolu ya da kuyrukta bekleme süresi doldu; `Retry-After` başlığı |
| 500 | `internal_error` | Beklenmeyen hata; üretilen ispat doğrulama anahtarıyla doğrulanamadı |

Politika ihlali hata değildir: devre ret kodunu (public sinyal 0) ispatlar ve escrow ödemeyi bu kodla
reddeder. Örneğin engelli payee için yanıt 200'dür, `publicInputs[0]` 8'dir.

## Artefaktlar

| Dosya | Kaynak |
|---|---|
| `manifest.json` | `circuits/payment-compliance/artifacts/manifest.json` (BC-20) |
| `payment.zkey` | `circuits/payment-compliance/artifacts/payment.zkey` (BC-20, geliştirme phase-2'si) |
| `payment.wasm` | devreden derlenir (`circuits/payment-compliance/scripts/build.mjs`, circom 2.2.3) |

Servis açılışta wasm ve zkey'in SHA-256'sını manifest'le karşılaştırır; uymazsa açılmaz. Artefakt
sürümü zkey'in SHA-256'sıdır. Doğrulama anahtarı zkey'den çıkarılır ve her ispat dönmeden önce onunla
doğrulanır. zkey tek katılımcılı bir geliştirme setup'ıdır; mainnet öncesi kamusal ceremony BC-38'de.

## Yapılandırma

Tüm değişkenler zorunludur; eksik ya da geçersiz değerde servis açılmaz.

| Değişken | Açıklama |
|---|---|
| `PROVER_SERVICE_PORT` | HTTP portu |
| `PROVER_METRICS_PORT` | `/metrics` portu (servis portundan farklı, iç ağ) |
| `CORS_ORIGINS` | Virgülle ayrılmış izinli origin URL'leri |
| `PROVER_API_KEY_SHA256` | İzinli API anahtarlarının SHA-256'sı (64 küçük harf hex, virgülle); anahtarın kendisi ortamda tutulmaz. Rotasyonda eski ve yeni özet birlikte verilir |
| `PROVER_MAX_CONCURRENT` | Aynı anda üretilen en fazla ispat |
| `PROVER_MAX_QUEUE` | Sırada bekleyebilecek en fazla istek |
| `PROVER_QUEUE_TIMEOUT_MS` | Sırada bekleme sınırı; `Retry-After` bundan türetilir |
| `PROVER_MANIFEST_PATH` | `manifest.json` yolu |
| `PROVER_WASM_PATH` | `payment.wasm` yolu |
| `PROVER_ZKEY_PATH` | `payment.zkey` yolu |

Docker imajı artefakt yollarını kendisi verir; diğerleri dağıtımda tanımlanır. Anahtar özeti:
`printf %s "$ANAHTAR" | shasum -a 256`.

## Geliştirme

```bash
node circuits/payment-compliance/scripts/build.mjs        # wasm (circom 2.2.3 gerekir)
pnpm --filter @squaresdk/solana-prover... build
pnpm --filter @squaresdk/solana-prover test               # gerçek artefaktlarla ispat, tamper, HTTP
```

Testler devrenin `test-inputs/` senaryolarının (14) hepsinin ispatını üretir, sinyalleri beklenen
değerlerle karşılaştırır ve ispatı depodaki doğrulama anahtarıyla bağımsız doğrular. Tamper testleri:
ispatın ya da bir public sinyalin tek değişikliği doğrulamayı düşürür; tek baytı değişmiş zkey ya da
wasm ile servis açılmaz.

Docker imajı (circom ikilisi linux-amd64 olduğu için `--platform linux/amd64`):

```bash
docker build --platform linux/amd64 -f apps/prover/Dockerfile .
```

## Lisans

Aperture'dan taşınan dizin: [`LICENSE`](LICENSE) (MIT). snarkjs GPL-3.0'dır; servis imajı
dağıtılmadan önceki hukuki inceleme [`docs/THIRD_PARTY_LICENSES.md`](../../docs/THIRD_PARTY_LICENSES.md)'de.
