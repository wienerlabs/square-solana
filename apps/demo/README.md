# apps/demo: demo senaryosu ve demo agent'ı

**Issue:** BE-21 (#65) · **Paket:** `@squaresdk/solana-demo` (private, yayımlanmaz) ·
**Yapı taşları:** [`@squaresdk/solana-agent-sdk`](../../packages/agent-sdk/) (BE-19), [smoke](../../tests/smoke/) (BC-30,
BC-31), [`@squaresdk/solana-policy`](../../packages/policy/) (BE-10)

8 adımlı demonun tekrar kurulabilir verisi, gerçekten iş teslim eden bir agent ve ispat onay / ret senaryoları. Square
yalnızca devnet'te çalışır ([ADR 0027](../../docs/decisions/0027-yalnizca-devnet.md)); aynı komutlar localnet'te de
koşar ve küme bir JSON yapılandırmasıyla seçilir.

| Komut | Ne yapar |
|---|---|
| `seed` | Kümeye demo verisini kurar: SOL ve devnet USDC dağıtımı, screening kayıtları, kurum, politikalar ve alıcı listesi, agent kaydı. Tekrar koşulduğunda değişiklik yapmaz (`changes: 0`). Adresleri JSON olarak yazar |
| `scenario` | Seçilen senaryoları koşar: kurum job açıp fonlar ve kabul öncesi ön-ispatı bağlar, işi A2A ile demo agent'a gönderir, agent kabul edip teslim eder, (isteğe bağlı) alacak satılır, kurum release ispatını bağlar, keeper finalize eder; her adım zincirden doğrulanır |
| `agent` | Demo agent'ı tek başına çalıştırır (kart, A2A uç noktası, teslimatlar); kaydını kartla eşler. Yalnızca agent anahtarını taşıyan bir yapılandırmayla çalışır |
| `demo:localnet` | Geçici bir `solana-test-validator` açar, smoke'un `init`'ini, `seed`'i iki kez (ikincisi değişiklik yapmamalı) ve bütün senaryoları süreç içi agent'la koşar, her şeyi kapatır |

```bash
pnpm turbo run build --filter @squaresdk/solana-demo...
pnpm --filter @squaresdk/solana-demo seed --config <küme.json> [--rotate-policy-secret]
pnpm --filter @squaresdk/solana-demo scenario --config <küme.json> [--scenario <ad>]... [--out <sonuç.json>]
pnpm --filter @squaresdk/solana-demo scenario --config <küme.json> --agent-url <agent adresi>   # SQUARE_DEMO_A2A_KEY
pnpm --filter @squaresdk/solana-demo agent --config <agent.json> [--port 8787] [--host 127.0.0.1] \
  [--institution <adres>]... [--list-claims]                                # SQUARE_DEMO_A2A_KEY
pnpm --filter @squaresdk/solana-demo demo:localnet [--deploy-dir target/deploy] [--ledger <dizin>] [--rpc-port 8899] \
  [--faucet-port 9900] [--gossip-port 8001] [--dynamic-port-range 8100-8200] [--scenario <ad>]... [--out <sonuç.json>]
pnpm --filter @squaresdk/solana-demo test                                 # zincirsiz birim testleri
```

- Yapılandırma `--config` ya da `SQUARE_DEMO_CONFIG` ile verilir. Her komut yalnızca kendi anahtarlarını okur: `seed`
  `payer`, `institution`, `agent`, `buyer`, `keeper` (ve yazılacak screening kaydı varsa `screener`); `scenario` `payer`,
  `institution`, `buyer`, `keeper` (süreç içi agent'la ayrıca `agent`); `agent` yalnızca `agent`.
- **Küme koruması:** `seed`, `scenario` ve `agent` RPC'nin genesis hash'ini okur. Genesis mainnet-beta'nınsa küme adı ne
  olursa olsun durur; küme adı `devnet` ise genesis devnet'inki olmalıdır. Localnet serbesttir.
- `scenario` ve `demo:localnet` ispatı süreç içinde üretir (smoke'un prover'ı): devrenin wasm'ı önce derlenir,
  `circuits/payment-compliance/scripts/ci-build.sh` ([smoke README](../../tests/smoke/README.md)).

## Seed

Önce yalnızca okuyan denetimler koşar; biri tutmazsa hiçbir transfer yapılmaz:

1. RPC'nin genesis hash'i (küme koruması);
2. config'ler kurulu ve settlement mint yapılandırmadakiyle aynı;
3. kurum hesabı varsa Squads vault'una bağlı değil; `demo.agent.wallet` verilmişse agent anahtarıyla aynı;
4. üç cüzdanın screening kaydı `Flagged` değil; yazılacak kayıt varsa screener anahtarı verilmiş ve config'teki
   authority;
5. politika sırrı okunabiliyor ya da üretilebiliyor (aşağıda);
6. `payer`'ın settlement token bakiyesi dağıtıma yetiyor.

Sonra her adım zinciri okur ve yalnızca eksik olanı yazar. İkinci koşu aynı kurulumu bulur ve tx göndermez; senaryolar
bakiyeleri harcadıysa onları hedefe tamamlar.

| Adım | Ne kurulur | Tekrar koşuda |
|---|---|---|
| SOL | `payer`'dan agent'a ve keeper'a `funding.agentLamports` / `funding.keeperLamports` hedefine kadar SOL. Agent kendi tx ücretlerini öder (kabul, teslim, listeleme, kayıt) | Hedefteyse dokunulmaz; kayıt ücretinden sonra hedefe yeniden tamamlanır |
| Devnet USDC dağıtımı | `payer`'ın settlement token hesabından kuruma ve alıcıya `funding.institutionUsdc` / `funding.buyerUsdc` hedefine kadar `transferChecked` (ATA'lar idempotent açılır); keeper'ın token hesabı | Hedefteyse dokunulmaz |
| Screening | Kurum, agent ve alıcı cüzdanları için `record_screening` (`Clear`), imzacı screener authority. `source_hash`, `{ source: "square-demo-seed", version, cluster, role, wallet }` belgesinin RFC 8785 + SHA-256'sıdır | Süresi `screening.minRemainingSecs`'ten fazla kalan temiz kayıt yeniden yazılmaz |
| Kurum | `initInstitution(institutionName)`, yetkili kurum anahtarı | Varsa dokunulmaz |
| Politikalar ve alıcı listesi | Her politika için `setPolicy` (yoksa) ya da `updatePolicy` (commitment veya public tavan değiştiyse), ardından `setBuyerRoot`. Politika kimliği `SHA-256("square-demo/policy/<ad>")`, salt'lar politika sırrından (`policySecret`). Alıcı listesi `buyer` ve `extraBuyers`; yaprak salt'ı sırdan türer, kök her koşuda aynıdır | Commitment, tavan ve kök zincirdekiyle aynıysa tx yok |
| Agent kaydı | Demo agent'ın kartıyla agent-sdk `register()` (kart agent'ın kendi adresinde, `register_agent`) | Kart, adres ve cüzdan aynıysa `unchanged` |

- **Politika sırrı:** 32 bayt hex, `0600`, üstüne yazılmaz; CLI'nin `policy secret` biçimidir, `squaresdk-solana --secret`
  de okur. Dosyanın dizini var olmalıdır; yol dizinin gerçek yoluyla çözülür, depoya giden sembolik bağ da reddedilir.
  Dosya yoksa yalnızca zincirde bu kurumun demo politikası henüz yoksa üretilir. Politika varken dosya yoksa (ör. yanlış
  yazılmış yol) seed durur; yeni sırla bütün politikaları `updatePolicy` ile yeni sürüme taşımak için
  `--rotate-policy-secret` verilir.
- **Çıktı:** standart çıktıya ve (verilmişse) `seed.output`'a JSON: kurum (cüzdan, `Institution` PDA'sı, USDC hesabı ve
  bakiyesi), politikalar (adres, `policyId`, sürüm, commitment, public tavan, alıcı kökü), alıcılar, agent (cüzdan,
  `AgentRecord`, `did:aip`, kart adresi ve hash'i), keeper, screening kayıtları, adım adım `actions` ve `changes`.
  Politika belgesi ve sır çıktıya yazılmaz.

## Demo agent

agent-sdk'nın `createAgent`'ı üzerinde, tek beceri: **`solana.account-report`**. Job spec'inde adı geçen hesapların
zincirdeki durumunu RPC'den okur ve JSON rapor olarak teslim eder.

- **Neden bu iş:** Ücretli bir API anahtarı istemez; agent'ın zaten kullandığı RPC yeter. Çıktı hem girdiye (spec'teki
  hesaplar) hem zincirin o anki durumuna (slot, bakiyeler, son işlemler) bağlıdır; sabit ya da hazır bir çıktı yoktur.
  Kurum raporu aynı RPC'den yeniden okuyarak doğrulayabilir. Rapor job'a bağlıdır: `job` adresini ve spec'in hash'ini
  (zincirdeki `spec_hash`) taşır.
- **Spec:** `{ "capability": "solana.account-report", "accounts": [<adresler>], "signatures": <sayı>, "request": "<koşu
  kimliği>" }`. `signatures` zorunludur, varsayılanı yoktur. Bir job'un RPC yükünü sınırlayan iki değer agent'ın
  yapılandırmasındadır: en çok `demo.agent.maxReportAccounts` hesap ve hesap başına en çok `demo.agent.maxReportSignatures`
  imza. Kodda yalnızca biçim kuralları kalır: hesaplar boş olmayan, tekrarsız, kanonik base58 adres listesi; `signatures`
  negatif olmayan tamsayı; yapılandırmanın üst sınırları RPC'nin kendi sınırlarıdır (`getMultipleAccounts` 100 hesap,
  `getSignaturesForAddress` 1 000 imza). Geçersiz spec `accept_job`'dan önce reddedilir (`admit`); job fonlu kalır.
- **Rapor:** her hesap için tür (`wallet`, `tokenAccount`, `mint`, `program`, `square`, `other`, `missing`), lamport ve
  SOL, sahip program ve adı (System, SPL Token, Token-2022, yükleyiciler, dört Square programı), rent muafiyeti, token
  hesabında mint / sahip / tutar (mint'in ondalığıyla), mint'te arz ve yetkililer, Square hesabında IDL discriminator'ından
  hesap tipi (`Job`, `AgentRecord`, `Policy` ...), son imzalar (sayı, başarısız sayısı, en yeni slot ve zaman); özet:
  türlere göre sayılar, toplam SOL, mint başına token toplamları.
- **Teslimat:** `application/json`. Agent içeriği SHA-256'sıyla saklar ve `<publicUrl>/deliveries/<sha256>` yolundan
  sunar; agent-sdk makbuzu içerikle karşılaştırır, `submit_work`'e bu hash ve adres gider. Teslimat adresi, URL'nin
  normalleştirilmiş hâliyle (ASCII dışı yol yüzde kodlanır, alan adı punycode olur) 128 baytı aşmamalıdır; yapılandırma
  bunu açılışta denetler.
- **A2A:** Kurumun anahtarı `x-api-key` ile gelir (`SQUARE_DEMO_A2A_KEY`, en az 16 karakter); agent yalnızca anahtarın
  SHA-256'sını tutar. Anahtarın adına iş açabileceği kurum cüzdanları açık adrestir: `--institution` ya da
  `demo.agent.institutions`. Agent kurum anahtarını okumaz.
- **Tekrar deneme ve teslim payı:** `demo.agent.retry` agent-sdk'ya geçer: `minDelayMs`, `maxDelayMs` (geçici hatada
  bekleme aralığı) ve `submitMarginSecs` (deadline'a bu kadar kala iş kabul edilmez ve teslim denenmez).
- **Görev deposu:** Görevler bellekteki depodadır (`src/memory-store.ts`, `TaskStore` arayüzü); süreç yeniden başlarsa
  yarım kalan görev sürdürülmez. Kalıcı depo gereken dağıtımda agent-sdk'nın Postgres deposu kullanılır.
- **Alacak listeleme:** Agent alacağı yalnızca açıkça istenince listeler (`list_claim`, indirim
  `demo.agent.autoListClaimBps`). Süreç içi agent yalnızca `claimSale: true` olan senaryoda listeler; tek başına çalışan
  agent yalnızca `--list-claims` ile listeler. Listeleme agent geneline uygulanır: `--list-claims` açıkken satışsız
  senaryonun alacağı da listelenir. Onaylı bir alıcı onu challenge penceresinde alırsa payee alıcı olur ve senaryonun
  "payee agent" denetimi tutmaz. Bu yüzden satışsız senaryolar tek başına agent `--list-claims` olmadan çalışırken
  koşulur.

## Senaryolar

`demo.scenarios` altındaki her senaryo bir ispat varyantıdır: `expect` `approved` ya da `refused`. Koşucu kurum ve keeper
rolündedir; agent tarafındaki her tx'i agent kendisi imzalar. Süreç içi agent her senaryo için ayrı açılır ve kapanır.

| Adım | Koşucunun yaptığı | Zincirden doğrulanan |
|---|---|---|
| Ön koşul | Küme koruması, politikayı sırdan kurar, agent'ın kartını indirir | Commitment zincirdekiyle aynı; agent kaydının cüzdanı yapılandırmadaki; kartın SHA-256'sı `agent_card_hash` |
| 3 | `createJob` (politikalı) + `fundJob`; kabul öncesi ön-ispat süreç içinde, `setPreflightProof` ([ADR 0028](../../docs/decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)) | Vault'ta tutar, kurumdan düştü; `PreflightProof` bu job'un ve politikanın, payee agent cüzdanı, ret kodunda kalıcı ya da günlük tavan biti yok |
| 4 | A2A `SendMessage`, görev bitene kadar `GetTask` (`demo.timing.taskTimeoutSecs`) | Görev `COMPLETED`; job `Delivered`; makbuz, `work_hash` ve `delivery_uri` aynı; teslimatın SHA-256'sı `work_hash`; agent aynı baytları sunuyor; rapor bu job'un |
| 5 | `claimSale: true` ise agent'ın listelediği alacağı (`demo.timing.claimListingTimeoutSecs` içinde) seed'deki alıcı listesinin Merkle kanıtıyla alır | Listeleme `Bought`, agent fiyatı aldı |
| 7 | Release ispatı süreç içinde, `setComplianceProof` | `approved`: uyumlu, payee agent (satıldıysa alıcı), net tutar; `refused`: payee alıcı, ret kodu tam olarak `refusalRules`'un kodu ve kesin ret |
| 6 + 8 | Challenge bitince `finalizePayment` (keeper); başka bir keeper önce kapattıysa yalnızca okur | `approved`: `Released`, `ValidationRecord` `Verified`, payee'ye net, keeper'a ücret; `refused`: `Refunded`, `ValidationRecord` `Refused`, net kuruma, alacak `Defaulted`, alıcıya ödeme yok |

- **Ret varyantı:** Kabul öncesi ön-ispat işin tam tutarını, mint'ini ve agent cüzdanını kabulden önce denetler. Bu
  yüzden kesin ret yalnızca alacak, politikanın engelli payee listesindeki onaylı bir alıcıya satılınca çıkar
  (ADR 0028). Ret senaryosu buna göre kurulur:
  - alacak satışlıdır (`claimSale: true`);
  - politikasının `blockedPayees`'i `buyer`'ı içerir; alıcı yine alıcı listesindedir, alacağı alabilir;
  - `refusalRules` `payeeBlocked`'ı içerir. `perTx` ve `mintNotAllowed` ön-ispattan geçmiş işte çıkamaz, yapılandırma
    onları reddeder.

  Ret kodu tam olarak `refusalRules`'un kodu olmalı ve ret kesin olmalı. Escrow neti kuruma iade eder; alıcı alacağa
  ödediği fiyatı geri almaz (alıcının fiyata kattığı risk, ADR 0014). Alıcıyı engelleyen politikada alacak satışlı onay
  senaryosu kurulamaz. Tutar Travel Rule eşiğinin altında olmalıdır.
- **Hata olursa:** `createJob`'dan sonraki herhangi bir adım düşerse koşucu job'u okur. Job `Open` ya da `Funded` ise
  `cancel_job` gönderir ve vault'taki tutar kuruma döner. `Accepted` ise iptal deadline'dan sonra mümkündür; koşucu
  deadline'ı yazar, kurum o zaman `squaresdk-solana job cancel --job <job>` ile tutarı geri alır. `Delivered` iş normal
  yoldan (finalize ya da ispat zaman aşımı) kapanır.
- **Dış agent:** `--agent-url` https olmalıdır; http yalnızca yerel adreste (127.0.0.1, localhost, ::1) kabul edilir.
  Koşucu agent'ın gizli anahtarını okumaz; agent cüzdanı `demo.agent.wallet`'tan gelir.
- **Zamanlama:** bütün bekleme ve yoklamalar `demo.timing`'den gelir; ispat, finalize ile aynı UTC gününde kalmak için gün
  dönümüne `demo.timing.proofDayMarginSecs`'ten az kalmışsa ertesi güne bırakılır
  ([ADR 0012](../../docs/decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md)).

## Yapılandırma

Dosya smoke'un küme yapılandırmasıdır ([alanlar](../../tests/smoke/README.md#küme-yapılandırması)); `seed` ve `demo`
bölümleri eklenir. Aynı dosya smoke'un `init` ve `smoke` komutlarıyla da kullanılır. Anahtar içerikleri dosyada ve depoda
bulunmaz; göreli yollar dosyanın dizinine göre çözülür.

Harcama, rent ve zaman sınırlarının hiçbirinin kodda varsayılanı yoktur: tutarlar, bakiye hedefleri, süreler, yoklama
aralığı, tekrar deneme, RPC yükü ve politikanın zaman penceresi yapılandırmada açıkça verilir ve açılışta zod ile
doğrulanır; eksikse komut başlamaz.

| Alan | Açıklama |
|---|---|
| `seed.institutionName` | Kurumun zincirdeki adı (en fazla 64 bayt) |
| `seed.policySecret`, `seed.output` | Politika sırrının yolu (repo dışı, dizini var), seed çıktısının yolu (isteğe bağlı) |
| `seed.policies.<ad>` | `maxPerTx`, `maxDaily`, `dailyCeiling` (settlement mint'in atomik birimi), `categories`, `timeWindow` (`{ days, startHourUtc, endHourUtc }` ya da her an için açıkça `null`), `blockedPayees` (isteğe bağlı, varsayılan boş: politikanın engelli payee listesi, en çok 10; `buyer` rolü ya da adres). Ad `[a-z0-9-]`, en fazla 8 politika |
| `seed.extraBuyers` | Alıcı listesine `buyer`'ın yanında eklenen adresler (en fazla 15) |
| `seed.funding` | `institutionUsdc`, `buyerUsdc` (token hedefleri), `agentLamports`, `keeperLamports` (SOL hedefleri) |
| `seed.screening.minRemainingSecs` | Kaydın yeniden yazılması için kalan süre eşiği |
| `demo.agent` | `agentId` (registry `agent_id`), `name`, `description`, `version`, `publicUrl` (https; teslimat adresi 128 baytı aşmamalı), `price`, `maxReportAccounts` (1-100), `maxReportSignatures` (0-1000), `retry` (`minDelayMs`, `maxDelayMs`, `submitMarginSecs`), `autoListClaimBps` (isteğe bağlı, 1-9999; listeleme yalnızca istenince), `institutions` (A2A anahtarının adına iş açabileceği kurum cüzdanları, açık adres), `wallet` (agent cüzdanının açık adresi; `--agent-url` ile zorunlu) |
| `demo.timing` | `taskTimeoutSecs` (A2A görevinin bitmesi), `claimListingTimeoutSecs` (agent'ın alacağı listelemesi), `a2aRequestTimeoutSecs` (tek A2A isteği), `pollIntervalMs` (görev, listeleme ve zincir saati yoklaması), `proofDayMarginSecs` (ispatın aynı UTC gününde kalma payı) |
| `demo.scenarios.<ad>` | `policy` (seed'deki ad), `expect` (`approved` / `refused`), `refusalRules` (`refused`'da zorunlu, `approved`'da verilmez; `payeeBlocked`'ı içerir, ör. `["payeeBlocked"]`), `amount` (agent'ın fiyatından az olamaz), `paymentCategory`, `challengePeriodSecs`, `deadlineSecs`, `claimSale` (varsayılan `false`; `refused`'da `true` olmalı), `report.targets` (en çok `maxReportAccounts`; rol: `payer`, `institution`, `agent`, `buyer`, `keeper`; rolün token hesabı: `<rol>:usdc`; `institution:pda`; `mint`; ya da adres), `report.signatures` (en çok `maxReportSignatures`) |

`agent` komutunun yapılandırması bu dosyanın bir alt kümesidir: `cluster`, `rpcUrl`, `commitment`, `programIds`,
isteğe bağlı `lookupTable` ve `computeUnitPrice`, `keys.agent` ve `demo.agent`. Tam yapılandırma da verilebilir; o
durumda yalnızca bu alanlar okunur ve başka anahtar dosyası açılmaz.

## Localnet

```bash
pnpm --filter @squaresdk/solana-demo demo:localnet --deploy-dir target/deploy --rpc-port 38899 --faucet-port 39900 \
  --gossip-port 38001 --dynamic-port-range 38100-38200 --out /tmp/demo-localnet.json
```

Programlar `target/deploy/*.so`'dan yüklenir (derlenmez) ve zincirdeki executable hash'leri `.so` dosyalarıyla
karşılaştırılır. Rol anahtarları, upgrade authority ve 6 ondalıklı mint koşu için geçici bir dizinde üretilir. Bu geçici
zincirin musluğu olarak `payer`'a 100 SOL, admin'e 10 SOL airdrop edilir ve faucet yerine `payer`'a seed'in dağıtacağı
USDC (`funding.institutionUsdc + funding.buyerUsdc`) basılır. Localnet yapılandırması
([`src/localnet.ts`](src/localnet.ts)): `standard` ve `blocked-buyer` politikaları (ikisi de işlem başı 10 USDC, her gün
00-23 UTC; `blocked-buyer` alıcıyı engelli payee listesine koyar), üç alıcılı liste, agent fiyatı 1 USDC, `autoListClaimBps` 300, en çok 8 hesap ve 10 imza,
`retry` 1 sn / 30 sn / 30 sn, `timing` 120 sn görev, 60 sn listeleme, 30 sn istek, 500 ms yoklama, 180 sn gün payı ve üç
senaryo:

| Senaryo | Politika | Tutar | Sonuç |
|---|---|---|---|
| `approved` | `standard` | 5 USDC | ispat uyumlu, `Released`, agent'a 4,975 USDC |
| `approved-claim` | `standard` | 4 USDC, alacak satışı | alıcı 3,88 USDC'ye alır; ispat uyumlu, `Released`, alıcıya 3,98 USDC |
| `refused` | `blocked-buyer` | 5 USDC, alacak satışı, `refusalRules: ["payeeBlocked"]` | alıcı 4,85 USDC'ye alır; ret kodu 8 (`payeeBlocked`), `Refunded`, kuruma 4,975 USDC, alacak `Defaulted`, alıcıya ödeme yok |

Çıktı: iki seed satırı (ilki değişiklik sayısı, ikincisi `0 değişiklik`) ve senaryo başına bir satır; `--out` bütün
sonucu (seed çıktıları, senaryoların job, görev, teslimat, rapor, ispat ve ödeme ayrıntıları, tx imzaları) JSON olarak
yazar. Validator ve agent koşu sonunda kapanır; hata olursa validator günlüğünün yolu yazılır. CI'da `Services` iş akışı
aynı komutu her PR'da koşar ([docs/ci.md](../../docs/ci.md)).

## Devnet: adım adım

Programlar, config'ler ve Square ALT'ı devnet'te kuruludur ([deploy kaydı](../../docs/deploy/devnet.md)); demo onları
kullanır, yeniden kurmaz. Bir anahtar sahibi şu adımlarla koşar:

1. **Anahtarlar:** `payer`, `institution`, `agent`, `buyer`, `keeper` için ayrı anahtarlar, depo dışında:

   ```bash
   mkdir -p ~/square-devnet/keys && chmod 700 ~/square-devnet/keys
   for role in payer institution agent buyer keeper; do
     solana-keygen new --no-bip39-passphrase --silent -o ~/square-devnet/keys/$role.json
   done
   ```

   Smoke'un devnet anahtarları da kullanılabilir. Kurum anahtarı Squads'a bağlı olmamalıdır.
2. **Screening:** Kaydı yalnızca registry config'indeki screener authority
   (`48DGxja6FefZHhZ8e5ynLKWLqxb1pVfiHFUVg1Jrm54b`) yazar; anahtar secret store'dadır ve kopyalanmamalıdır. Tercih edilen
   yol cüzdanların önce OFAC listesine karşı taranmasıdır: screener servisi (`POST /v1/screenings`) ya da
   [screener runbook'u](../../docs/runbooks/screener.md) (`scripts/deploy/record-screening.mjs`). Seed taze temiz kaydı
   yeniden yazmaz ve `keys.screener` verilmez. Servis ya da runbook kullanılamıyorsa authority anahtarı yalnızca seed'in
   koştuğu makinede, koşu süresince `keys/screener.json` olarak verilir; agent'ın sunucusuna asla konmaz.
3. **SOL:** `payer` ücretleri, rent'i ve agent ile keeper'ın SOL'ünü öder; en az 1 SOL:

   ```bash
   solana airdrop 2 $(solana-keygen pubkey ~/square-devnet/keys/payer.json) -u devnet
   ```

   RPC sınırına takılırsa <https://faucet.solana.com>.
4. **Devnet USDC:** Circle'ın devnet mint'i `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. <https://faucet.circle.com>
   ("Solana Devnet") ile **payer'ın** adresine en az `funding.institutionUsdc + funding.buyerUsdc` gönderilir; seed kuruma
   ve alıcıya dağıtır.
5. **Yapılandırma (koşucunun makinesi):** `~/square-devnet/demo.json`. Küme alanları devnet kaydınınkiler, `keys` yolları
   `keys/<rol>.json`. Challenge süresi devnet'te en az 60 sn, Travel Rule eşiği 1 000 USDC'dir. Devnet'in public RPC'si
   için yoklama aralığı localnet'tekinden uzun tutulur:

   ```json
   {
     "cluster": "devnet",
     "rpcUrl": "https://api.devnet.solana.com",
     "commitment": "confirmed",
     "programIds": {
       "registry": "AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9",
       "policy": "63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4",
       "verifier": "8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh",
       "escrow": "6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX"
     },
     "settlementMint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
     "lookupTable": "3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG",
     "computeUnitPrice": 1000,
     "keys": {
       "payer": "keys/payer.json",
       "institution": "keys/institution.json",
       "agent": "keys/agent.json",
       "buyer": "keys/buyer.json",
       "keeper": "keys/keeper.json"
     },
     "seed": {
       "institutionName": "Square demo kurumu",
       "policySecret": "state/policy-secret",
       "output": "state/seed-devnet.json",
       "policies": {
         "standard": {
           "maxPerTx": "2000000", "maxDaily": "20000000", "dailyCeiling": "50000000", "categories": ["research"],
           "timeWindow": { "days": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], "startHourUtc": 0, "endHourUtc": 23 }
         },
         "blocked-buyer": {
           "maxPerTx": "2000000", "maxDaily": "20000000", "dailyCeiling": "50000000", "categories": ["research"],
           "timeWindow": { "days": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], "startHourUtc": 0, "endHourUtc": 23 },
           "blockedPayees": ["buyer"]
         }
       },
       "funding": { "institutionUsdc": "5000000", "buyerUsdc": "2000000", "agentLamports": "100000000", "keeperLamports": "50000000" },
       "screening": { "minRemainingSecs": 86400 }
     },
     "demo": {
       "agent": {
         "agentId": "square-demo-reporter",
         "name": "Square demo agent",
         "description": "Job spec'inde adı geçen Solana hesaplarının zincirdeki durumunu raporlar.",
         "version": "1.0.0",
         "publicUrl": "<agent'ın https adresi>",
         "price": "500000",
         "autoListClaimBps": 300,
         "maxReportAccounts": 8,
         "maxReportSignatures": 10,
         "retry": { "minDelayMs": 1000, "maxDelayMs": 30000, "submitMarginSecs": 60 },
         "wallet": "<agent cüzdanının adresi>"
       },
       "timing": {
         "taskTimeoutSecs": 300, "claimListingTimeoutSecs": 120, "a2aRequestTimeoutSecs": 30,
         "pollIntervalMs": 2000, "proofDayMarginSecs": 300
       },
       "scenarios": {
         "approved": { "policy": "standard", "expect": "approved", "amount": "1000000", "paymentCategory": "research", "challengePeriodSecs": 60, "deadlineSecs": 3600, "report": { "targets": ["institution", "institution:usdc", "mint"], "signatures": 5 } },
         "approved-claim": { "policy": "standard", "expect": "approved", "amount": "1000000", "paymentCategory": "research", "challengePeriodSecs": 60, "deadlineSecs": 3600, "claimSale": true, "report": { "targets": ["buyer", "buyer:usdc", "agent:usdc"], "signatures": 3 } },
         "refused": { "policy": "blocked-buyer", "expect": "refused", "refusalRules": ["payeeBlocked"], "amount": "1000000", "paymentCategory": "research", "challengePeriodSecs": 60, "deadlineSecs": 3600, "claimSale": true, "report": { "targets": ["agent", "keeper"], "signatures": 2 } }
       }
     }
   }
   ```

   `publicUrl`, kartın ve teslimatların zincire yazılan adresidir: agent'ın dışarıdan erişilen https adresi (Railway ya da
   bir tünel). Agent yalnızca koşucunun süreci içinde çalışacaksa adres erişilemez kalır; kart ve teslimat o durumda
   zincirdeki adresten okunamaz, kurum içeriği A2A artefaktından alır ve hash'i zincirle karşılaştırır.
6. **Seed (iki kez):**

   ```bash
   mkdir -p ~/square-devnet/state && chmod 700 ~/square-devnet/state
   pnpm --filter @squaresdk/solana-demo seed --config ~/square-devnet/demo.json
   pnpm --filter @squaresdk/solana-demo seed --config ~/square-devnet/demo.json   # "seed: 0 değişiklik"
   ```

7. **Senaryolar:** Süreç içi agent'la:

   ```bash
   pnpm --filter @squaresdk/solana-demo scenario --config ~/square-devnet/demo.json --out ~/square-devnet/demo-devnet.json
   ```

   Ya da agent erişilebilir bir sunucuda tek başına çalışır ve koşucu ona bağlanır. Sunucuya yalnızca agent anahtarı ve
   aşağıdaki gibi yalnızca agent'ın alanlarını taşıyan bir yapılandırma konur; payer, kurum, alıcı, keeper ve screener
   anahtarları sunucuya gitmez:

   ```json
   {
     "cluster": "devnet",
     "rpcUrl": "https://api.devnet.solana.com",
     "commitment": "confirmed",
     "programIds": { "registry": "AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9", "policy": "63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4", "verifier": "8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh", "escrow": "6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX" },
     "lookupTable": "3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG",
     "computeUnitPrice": 1000,
     "keys": { "agent": "keys/agent.json" },
     "demo": {
       "agent": {
         "agentId": "square-demo-reporter", "name": "Square demo agent",
         "description": "Job spec'inde adı geçen Solana hesaplarının zincirdeki durumunu raporlar.", "version": "1.0.0",
         "publicUrl": "<agent'ın https adresi>", "price": "500000", "autoListClaimBps": 300,
         "maxReportAccounts": 8, "maxReportSignatures": 10,
         "retry": { "minDelayMs": 1000, "maxDelayMs": 30000, "submitMarginSecs": 60 },
         "institutions": ["<kurum cüzdanının adresi>"]
       }
     }
   }
   ```

   Kartın baytları iki yapılandırmada aynı olmalıdır (ad, açıklama, sürüm, `publicUrl`, fiyat); değişirse agent açılışta
   kaydını `update_agent` ile günceller. İki taraf aynı A2A anahtarını kullanır:

   ```bash
   export SQUARE_DEMO_A2A_KEY=$(openssl rand -hex 32)
   pnpm --filter @squaresdk/solana-demo agent --config ~/agent/agent.json --host 0.0.0.0 --port 8787   # sunucu
   pnpm --filter @squaresdk/solana-demo scenario --config ~/square-devnet/demo.json --agent-url https://<agent'ın adresi> \
     --scenario approved
   ```

   Ayrı agent'ın listeleme kipi açılışta sabittir, bu yüzden senaryolar iki koşuya bölünür: önce listeleme kapalıyken
   `approved`, sonra agent `--list-claims` ile yeniden başlatılıp `--scenario approved-claim --scenario refused`
   (yukarıdaki risk). Listeleme beklenirken koşu düşerse job `delivered` kalır; koşucu job'u ve çözüm yolunu günlüğe
   yazar. Her senaryo challenge penceresini (60 sn) bekler. Devnet'te keeper servisi (BE-15) çalışıyorsa
   finalize'ı o yapabilir; koşucu bunu görür ve yalnızca sonucu doğrular.
8. **Kayıt:** Seed çıktısı ve senaryo sonucu (job'lar, imzalar, teslimat hash'leri) devnet kaydına işlenir.

## Dosyalar

| Dosya | İçerik |
|---|---|
| [`src/demo-config.ts`](src/demo-config.ts) | `seed`, `demo` ve agent yapılandırmasının şeması; küme alanları smoke'un şemasıyla |
| [`src/cluster.ts`](src/cluster.ts) | Küme koruması (genesis hash) ve yerel adres kuralı |
| [`src/seed.ts`](src/seed.ts) | Seed'in ön denetimleri, adımları ve çıktısı |
| [`src/policies.ts`](src/policies.ts) | Politika sırrı, politika kimlikleri ve belgeleri, alıcı ağacı |
| [`src/report.ts`](src/report.ts) | Agent'ın işi: spec doğrulaması, hesap raporu, agent-sdk işleyicisi |
| [`src/agent.ts`](src/agent.ts), [`src/delivery.ts`](src/delivery.ts), [`src/memory-store.ts`](src/memory-store.ts) | Demo agent'ı, teslimat deposu ve sunucusu, bellekteki görev deposu |
| [`src/scenario.ts`](src/scenario.ts) | Senaryo koşucusu ve hata durumunda escrow'un iadesi |
| [`src/cli.ts`](src/cli.ts), [`src/localnet.ts`](src/localnet.ts) | Komutlar, komut başına anahtar okuma ve localnet koşucusu |

Birim testleri zincirsizdir. Zincirle çalışan akışlar (`seed.ts`, `scenario.ts`, komutlar ve localnet koşucusu)
`demo:localnet` koşusunda gerçek işlemlerle sınanır ve kapsam ölçümünün dışındadır; bu koşu CI'da da çalışır.

## Kalan

- Devnet koşusu yapılmadı: anahtarlar (payer ve önceden tarama ya da screener authority) bu işin koşusunda yoktu.
  Adımlar yukarıda; koşu kaydı devnet kaydına yazılır.
- Agent'ın Railway'de dağıtımı ve sağlık uçları BE-20'dedir. Teslimatlar ve görevler agent'ın belleğindedir; dağıtımda
  Square API'sinin teslimat ucu (`api` seçeneği) ve Postgres görev deposu kullanılabilir.
- Seed'in screening kaydı OFAC taraması değildir; demonun kanıt belgesini taşır. Gerçek tarama screener servisinin ya da
  runbook'un işidir (adım 2).
- A2A sunucusunun kaynak sınırları (istek gövdesi, akış sayıları, kalp atışı) agent-sdk'nın doğrulanmış
  varsayılanlarıdır; demo bunları değiştirmez.
