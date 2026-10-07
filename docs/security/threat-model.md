# Threat model: off-chain bileşenler

**Issue:** BE-32 (#94) · **Kapsam:** API, servisler, ödeme rayları ve web. Programlar BC-39'un (#93) kapsamındadır.
**Ağ:** yalnızca devnet ([ADR 0027](../decisions/0027-yalnizca-devnet.md)). İnceleme ve bulgular:
[review-be-32.md](review-be-32.md). Pen-test listesi: [pentest-checklist.md](pentest-checklist.md).

Yöntem STRIDE'dır: bileşen başına sahte kimlik (S), kurcalama (T), inkâr (R), bilgi sızıntısı (I), hizmet
engelleme (D) ve yetki yükseltme (E). Her tehdidin karşısında kodda uygulanan önlem yazılıdır. Önlemi olmayan ya da
yetersiz olan tehdit bir bulgudur.

## 1. Varlıklar

| Varlık | Nerede | Neden değerli |
|---|---|---|
| Escrow'daki USDC ve fiat ödemeler | zincir (vault), Square'in Stripe hesabı | Doğrudan para |
| İmzalayan servis anahtarları | servislerin secret store'u | Zincirde yetkisi olan ya da ücret ödeyen kimlik |
| Oturum belirteçleri ve API anahtarları | istemci; API'de yalnızca SHA-256 | Kullanıcı adına yazma |
| Kurumun politika belgesi ve sırrı | yalnızca kurumun makinesi | Gizli uyum kuralları |
| Travel Rule kayıtları | API, zarf şifrelemeli | Kişisel veri |
| Dispute kanıtları | özel kova | Taraflara ait belgeler |
| Uyum kayıtları (compliance-api) | Postgres | Satılan raporun girdisi |
| Hizmetin sürekliliği | bütün servisler | Ödeme ve finalize akışı |

**İmzalayan servis anahtarları:**

| Anahtar | Yetkisi |
|---|---|
| keeper | permissionless crank |
| screener authority | `ScreeningRecord` yazar |
| MPP authority | fiat attestation'ı imzalar |
| fee payer sponsoru | ücretleri öder |
| x402 fee payer | x402 işlemlerinin ücretini öder |

## 2. Aktörler

- **Kullanıcılar:** kurum (yetkilisi ya da Squads üyesi), agent (sahip, cüzdan), alıcı, arbitrator, keeper
  (permissionless).
- **Entegratörler:** geliştirici (x402 sunucusu), ödeme ajanı (`fiat:pay`).
- **Dış hizmetler:**
  - Stripe (webhook);
  - Helius (indexer webhook'u);
  - Circle (CCTP attestation);
  - OFAC listesi, isteğe bağlı Chainalysis (screening kaynakları);
  - RPC sağlayıcıları.
- **Saldırgan profilleri:**
  - kimliksiz internet kullanıcısı;
  - kendi kaynağı dışına yazmaya çalışan oturumlu kullanıcı;
  - kötü niyetli agent (teslimat ve kart içeriği);
  - sahte olay gönderen;
  - servisleri pahalı işe zorlayan (DoS / maliyet).

## 3. Güven sınırları

1. **İnternet → web ve API:** Railway'in kenarı. İstemci IP'si `API_TRUST_PROXY_HOPS` kadar vekilden güvenilir.
2. **API → iç servisler:** prover, fee payer, screener. Servis anahtarıyla (`x-api-key`, ortamda SHA-256).
   Metrics portları iç ağdadır.
3. **Servisler → zincir:** RPC failover. Zincir kaynak-gerçektir; ayna tablolarına yalnızca indexer yazar.
4. **Dış hizmetler → servisler:** imzalı olaylar. Stripe `Stripe-Signature` (HMAC, 300 s), Helius `Authorization`
   (SHA-256 karşılaştırma).
5. **Servisler → dış adresler:** arbitrator webhook'ları güvenli fetch'ten geçer. Yalnızca https, özel ağ adresleri
   ve yönlendirme yasak (`createSafeFetch`). Agent card'ları istemcide çözülür.
6. **Tarayıcı → cüzdan:** Uygulama yalnızca imzalatır. Ağ doğrulanmadan işlem gönderilmez (FE-03).

## 4. Tehditler ve önlemler

### API (`apps/api`)

| | Tehdit | Önlem |
|---|---|---|
| S | Başkasının cüzdanıyla oturum | Ed25519 challenge: alan adı ve süre mesajda. Nonce tek kullanımlık, transaction içinde tüketilir (`auth/service.ts`) |
| S | Smart account adına yazma | `X-Square-Smart-Account` tek başına yetki vermez; üyelik ve `Initiate` zincirden o anda okunur (FE-21) |
| T | Başkasının kaynağına yazma (IDOR) | Kaynak yetkisi servislerde: <ul><li>teslimat: agent cüzdanı / sahibi;</li><li>kart: kayıt sahibi;</li><li>politika meta ve Travel Rule: kurumun güncel yetkilisi;</li><li>kanıt: taraflar;</li><li>x402 tanımı: cüzdan;</li><li>fiat: kurumun yetkilisi</li></ul> |
| T | Sahte fiat ödemesi | <ul><li>Webhook imzası doğrulanır.</li><li>Makbuz PaymentIntent Stripe'tan yeniden okunarak kurulur.</li><li>Attestation işe ve tutara bağlıdır (ADR 0024, 0026).</li><li>İş başına tek ödeme; kopyası iade edilir.</li></ul> |
| R | İşlemi yapanın inkârı | Kayıtlara işlemi yapan cüzdan yazılır (`uploadedBy`, erişim kaydı, `updatedBy`). Travel Rule erişim kaydı yalnızca eklenir |
| I | Kişisel veri ve kanıt sızıntısı | <ul><li>Travel Rule zarf şifrelemeli, izinli okuma.</li><li>Kanıt özel kovada, yalnızca taraflara, indirme olarak, `no-store`.</li><li>Hata yanıtları iç sebebi taşımaz.</li><li>Health yalnızca `ok/fail` döner.</li></ul> |
| I | Gizli değerlerin depoda kalması | Oturum ve API anahtarının yalnızca SHA-256'sı saklanır. Webhook sırları secret box'ta |
| D | İstek seli ve pahalı uçlar | <ul><li>Okuma ve yazma için ayrı Postgres sayaçlı hız sınırı (cüzdan ya da IP başına).</li><li>Gövde sınırları.</li><li>Sayfa boyutu en çok 200.</li><li>Prover vekili kuyruklu.</li></ul> |
| E | Kapsam dışı API anahtarı kullanımı | Anahtarlar kapsamlıdır (`read`, `tx:prepare`, `fiat:pay` …). Anahtar oluşturma ve silme yalnızca oturumla |

### Prover, fee payer, screener, indexer, keeper

| Servis | Tehditler | Önlemler |
|---|---|---|
| prover | <ul><li>Kimliksiz ispat (CPU DoS);</li><li>yanlış artefakt</li></ul> | <ul><li>`x-api-key` (SHA-256);</li><li>eşzamanlılık ve kuyruk sınırı;</li><li>açılışta wasm ve zkey manifest'le doğrulanır;</li><li>her ispat dönmeden doğrulanır</li></ul> |
| fee payer | <ul><li>Sponsoru boşaltma;</li><li>istenmeyen talimatı ödetme</li></ul> | <ul><li>İzin listesi (ADR 0019);</li><li>cüzdan ve işlem başına tavanlar;</li><li>simülasyon;</li><li>oturum ya da anahtar;</li><li>hız sınırı</li></ul> |
| screener | <ul><li>Sahte screening isteği;</li><li>kaynak verisinin kurcalanması</li></ul> | <ul><li>`x-api-key`;</li><li>tarama ve okuma için ayrı hız sınırı;</li><li>kaynak boyut sınırı;</li><li>kanıt belgesinin SHA-256'sı zincirdeki kayıtta</li></ul> |
| indexer | Sahte webhook ile ayna kurcalama | <ul><li>Helius `Authorization` sabit sürede karşılaştırılır.</li><li>Webhook yalnızca imza listesi taşır; hesaplar zincirden okunur.</li><li>Uzlaştırma döngüsü aynayı zincirle karşılaştırır.</li></ul> |
| keeper | Yanlış finalize; anahtarın kötüye kullanımı | <ul><li>Programlar permissionless kuralları zorlar.</li><li>Anahtar yalnızca ücret için SOL tutar.</li><li>HTTP yüzeyi yalnızca health ve metrics.</li></ul> |

### Ödeme rayları

| Ray | Tehditler | Önlemler |
|---|---|---|
| x402 | <ul><li>Tekrar oynatma;</li><li>yanlış mint, alıcı ya da tutar</li></ul> | <ul><li>Resmi `@x402/*` exact şeması;</li><li>tekrar koruması Postgres'te (`replay_guards`);</li><li>ödeme tanımın ağı, mint'i ve alıcısıyla karşılaştırılır (ADR 0018, 0023)</li></ul> |
| CCTP | <ul><li>Başka işe bağlanmış burn;</li><li>yanlış mint alıcısı</li></ul> | <ul><li>Burn job'a tekil;</li><li>mint alıcısı kurumun hesabı;</li><li>Circle attestation'ı;</li><li>fonlama tx'i imzadan önce denetlenir</li></ul> |
| Stripe MPP | <ul><li>Sahte olay;</li><li>replay;</li><li>başka işin challenge'ı;</li><li>çift ödeme</li></ul> | <ul><li>HMAC ve 300 s tolerans;</li><li>olay ve PaymentIntent tekilliği;</li><li>challenge HMAC'li ve işe bağlı;</li><li>kopya iade</li></ul> |

### compliance-api

| | Tehdit | Önlem |
|---|---|---|
| T / E | Kimliksiz kayıt yazımı ve imzasız ödemelerin kapatılması | `X-API-Key` (SHA-256) ve anahtar başına hız sınırı (S-01, BE-32) |
| D | `reconcile` ile dış istek seli | Aynı erişim kuralı |
| I | Rapor | Ücretli (x402); yalnızca tutar aralıkları ve özetler |

### Web (`apps/web`)

| | Tehdit | Önlem |
|---|---|---|
| S / T | Clickjacking ile imza tıklatma | `frame-ancestors 'none'`, `X-Frame-Options: DENY` (S-03, BE-32) |
| T | Yanlış ağa işlem | Ağ koruması: RPC genesis hash'i yapılandırmayla eşleşmezse işlem cüzdana gitmez |
| I | Oturumun sızması | API oturumu `Authorization` başlığında. Çerez yok, CSRF yüzeyi yok |
| T | Kötü niyetli agent card'ı | <ul><li>Kart istemcide indirilir: yalnızca https, yönlendirme yok, boyut ve süre sınırı.</li><li>Hash zincirdekiyle doğrulanır.</li><li>React metni kaçışlar; ham HTML yok.</li></ul> |

## 5. Kalan riskler

- Yaması çıkmamış dolaylı bağımlılık advisory'leri: S-05 (#224), takipte.
- Stripe webhook'unda hız sınırı yok: S-06 (#225), kabul edildi.
- Teslimat deposu herkese açıktır: teslimatın içeriği gizli değildir (BE-18 tasarımı). Gizli içerik teslimattan
  önce şifrelenmelidir.
- Servis anahtarlarının saklanması dağıtımın secret store'una bağlıdır ([environments.md](../environments.md)).
- Programların güvenliği BC-39 ve dış audit (BC-40, BC-41) kapsamındadır.
