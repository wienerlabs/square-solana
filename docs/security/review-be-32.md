# Off-chain güvenlik incelemesi (BE-32)

**Issue:** BE-32 (#94) · **Tarih:** 2026-10-07 · **Commit:** BE-32 PR'ının birleşik commit'i (main `f305699`
üstüne) · **Model:** [threat-model.md](threat-model.md) · **Pen-test:** [pentest-checklist.md](pentest-checklist.md)

**Kapsam:**
- `apps/api`, `apps/compliance-api`, `apps/prover`, `apps/fee-payer`, `apps/screener`, `apps/indexer`,
  `apps/keeper`, `apps/web`;
- servislerin kullandığı paketler: `hardening`, `x402`, `cctp`, `identity`, `hosted`;
- ödeme rayları: x402, CCTP, Stripe MPP.

Programlar BC-39'dadır.

**Kaynak:** Covenant'ın `docs/SECURITY_AUDIT.md` ve `docs/AUDIT.md` bulgu sınıfları kontrol listesi olarak
kullanıldı:
- imzalayanın gövdedeki cüzdana bağlanmaması;
- imza tekrarı;
- SSRF;
- IDOR;
- kimliksiz yükleme ve pahalı uçlar;
- vekil başlığıyla hız sınırı atlatma;
- webhook tekrarı;
- sınırsız sorgular;
- health ve metrics sızıntısı;
- CORS;
- x402'nin tutar ve alıcı denetimi;
- MIME güveni.

Covenant'ın metni kopyalanmadı (LGPL-2.1).

## Sonuç

İç incelemede **kritik bulgu 0**. İki **yüksek** bulgu (S-01, S-02) ile orta ve düşük birer bulgu (S-03, S-04) bu
PR'da düzeltildi. Kalan iki düşük bulgu: S-05 takipte, S-06 kabul edildi. Her bulgu bir issue'dur.

| ID | Önem | Bileşen | Bulgu | Durum |
|---|---|---|---|---|
| [S-01](https://github.com/wienerlabs/square-solana/issues/220) | yüksek | compliance-api | Kayıt uçları (proof, attestation, imzasız ödeme, `reconcile`) kimliksiz ve hız sınırsız | Düzeltildi: `X-API-Key` (SHA-256) ve anahtar başına Postgres sayaçlı sınır |
| [S-02](https://github.com/wienerlabs/square-solana/issues/221) | yüksek | bağımlılıklar | `underscore`, `ws`, `deepmerge-ts`, `mysql2`, `toml` advisory'leri | Düzeltildi: `pnpm-workspace.yaml` `overrides` |
| [S-03](https://github.com/wienerlabs/square-solana/issues/222) | orta | web | Güvenlik başlıkları yok (clickjacking) | Düzeltildi: CSP `frame-ancestors`, `X-Frame-Options`, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy` |
| [S-04](https://github.com/wienerlabs/square-solana/issues/223) | düşük | API, teslimat deposu | Yüklenen HTML/SVG depoda tarayıcıda çalışabiliyor | Düzeltildi: `Content-Disposition: attachment` |
| [S-05](https://github.com/wienerlabs/square-solana/issues/224) | düşük | bağımlılıklar | Yaması olmayan advisory'ler (`bigint-buffer`, `braces` erişilemez; `uuid`, `stream-json`, `elliptic`; cargo unmaintained) | Açık, takipte |
| [S-06](https://github.com/wienerlabs/square-solana/issues/225) | düşük | API | Stripe webhook ucunda hız sınırı yok | Kabul edildi: HMAC önce, gövde sınırlı, imzasız istek I/O yapmaz |

**Önem ölçeği:**

| Önem | Tanım |
|---|---|
| kritik | Kimliksiz fon kaybı ya da anahtar ele geçirme |
| yüksek | Kimliksiz yetkisiz yazma, güvenilir veriyi bozma ya da sınırsız maliyet |
| orta | Kullanıcı etkileşimiyle yetkisiz eylem ya da önemli sızıntı |
| düşük | Sınırlı etki ya da derinlemesine savunma eksiği |

## 1. Threat model

[threat-model.md](threat-model.md):
- varlıklar, aktörler ve güven sınırları;
- bileşen başına STRIDE tehditleri ve kodda uygulanan önlemler;
- kalan riskler.

## 2. Bağımlılık denetimi

**npm** (`pnpm audit`):

| Aşama | Kritik | Yüksek | Orta | Düşük |
|---|---|---|---|---|
| Önce | 0 | 8 | 7 | 1 |
| Yamadan sonra | 0 | 2 | 5 | 1 |

`pnpm-workspace.yaml` `overrides` yamaları:

| Paket | Yamalı sürüm | Zincir | Erişilebilirlik |
|---|---|---|---|
| `underscore` | ^1.13.8 | snarkjs → bfj → jsonpath | Düşük: yalnızca JSON yolu sorgusunda |
| `ws` | ^8.21.0 | x402 → siwe → ethers | Düşük: SIWE uzantısı |
| `mysql2` | ^3.23.1 | prisma | Yok: Postgres kullanılır |
| `toml` | ^4.2.0 | @anchor-lang/core (`workspace.js`) | Yok: yerel `Anchor.toml` |
| `deepmerge-ts` | ^8.0.0 | prisma config | Yok: yapılandırma dosyası |

Kalan iki yüksek advisory'nin yaması yok ve ikisi de erişilemez:

| Paket | Neden erişilemez |
|---|---|
| `bigint-buffer` | Açık native eklentide; kurulum script'i kapalı, saf JS kullanılır |
| `braces` | Yalnızca react-native/metro araç zincirinde |

Ayrıntı: S-05.

**Rust** (`cargo deny check advisories`): Güvenlik açığı yok. Üç "unmaintained" bildirimi var: `bincode`
(RUSTSEC-2025-0141), `derivative` (RUSTSEC-2024-0388), `paste` (RUSTSEC-2024-0436). Üçü de Solana / Anchor araç
zincirinden; güvenli yükseltme yok. S-05'te takipte.

## 3. Yetki incelemesi

**apps/api** (60 operasyon):
- **Okuma uçları:** Herkese açık; anahtarla gelen okuma `read` kapsamı ister.
- **Yazma uçları:** Oturum ya da kapsamlı anahtar ister. Kaynak üzerindeki yetki serviste denetlenir:

  | Kaynak | Yetkili |
  |---|---|
  | teslimat | job'un agent cüzdanı ya da kayıt sahibi |
  | agent card | kayıt sahibi |
  | politika meta, Travel Rule, fiat | kurumun güncel yetkilisi (anahtar ya da Squads `Initiate` üyesi) |
  | dispute kanıtı | taraflar ve aktif arbitrator'lar |
  | oy | aktif arbitrator |
  | x402 tanımı | sahibi cüzdan |
  | CCTP kaydı | job'un kurumu |

- **Kimlik:**
  - Oturum challenge'ı tek kullanımlık; transaction içinde tüketilir.
  - Anahtarlar yalnızca oturumla oluşturulur ve silinir.
  - Oturum belirteci ve anahtar SHA-256 olarak saklanır.
  - `Authorization` ile `X-API-Key` birlikte gönderilemez.
  - Smart account başlığı tek başına yetki vermez.
- **İstisnalar:**
  - MPP ucunda kimlik yalnızca `X-API-Key`'dir, çünkü `Authorization` MPP credential'ıdır.
  - Webhook'un kimliği Stripe imzasıdır.

**Servisler:**

| Servis | Yetki |
|---|---|
| prover, screener | `x-api-key`; ortamda SHA-256, sabit sürede karşılaştırma |
| fee payer | Oturum ya da anahtar; izin listesi ve tavanlar |
| indexer webhook'u | `Authorization` SHA-256 karşılaştırması |
| keeper | HTTP yazma yüzeyi yok |
| compliance-api | Ücretli rapor x402 ödemesiyle. Kayıt uçları **kimliksizdi** (S-01): düzeltildi |

## 4. Hız sınırı kapsamı

| Bileşen | Kapsam | Anahtar |
|---|---|---|
| api | Her `/v1` ucu (okuma / yazma ayrı) | Oturum ya da anahtar cüzdanı; yoksa güvenilen vekil sayısına (`API_TRUST_PROXY_HOPS`) göre istemci IP'si |
| fee payer | `/v1` | Kimlik |
| screener | tarama ve okuma ayrı | Anahtar |
| prover | Eşzamanlılık ve kuyruk sınırı | — |
| compliance-api | Kayıt uçları (S-01) | Anahtar |

- **api, istisna:** Stripe webhook'u (S-06).
- **compliance-api:** Rapor ödeme ister.

Sayaçlar Postgres'te (`rate_limit_windows`), servis kopyaları arasında ortaktır. Covenant'ın serverless bellek
sınırlayıcısı sorunu bu yüzden yok.

## 5. Sır taraması

- `pnpm secrets:scan` (gitleaks, bütün geçmiş): **385 commit, sızıntı yok.**
- Staged değişiklikler pre-commit kancasıyla taranıyor.
- Kurallar `.gitleaks.toml`'da: Solana keypair dizileri değer bazında, istisnalar gerekçeli.
- Servis anahtarları yalnızca secret store'da. `.env*` dosyaları git dışında.

## 6. Pen-test hazırlığı

[pentest-checklist.md](pentest-checklist.md):
- yüzeyler;
- test hesapları ve ortam;
- bileşen başına test senaryoları;
- dağıtım yapılandırmasının güvenlik denetimi.
