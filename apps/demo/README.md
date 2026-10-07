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
| `scenario` | Seçilen senaryoları koşar: kurum job açıp fonlar, işi A2A ile demo agent'a gönderir, agent kabul edip teslim eder, (isteğe bağlı) alacak satılır, kurum ispatı bağlar, keeper finalize eder; her adım zincirden doğrulanır |
| `agent` | Demo agent'ı tek başına çalıştırır (kart, A2A uç noktası, teslimatlar); kaydını kartla eşler |
| `demo:localnet` | Geçici bir `solana-test-validator` açar, smoke'un `init`'ini, `seed`'i iki kez (ikincisi değişiklik yapmamalı) ve bütün senaryoları süreç içi agent'la koşar, her şeyi kapatır |

```bash
pnpm turbo run build --filter @squaresdk/solana-demo...
pnpm --filter @squaresdk/solana-demo seed --config <küme.json>
pnpm --filter @squaresdk/solana-demo scenario --config <küme.json> [--scenario <ad>]... [--out <sonuç.json>]
pnpm --filter @squaresdk/solana-demo scenario --config <küme.json> --agent-url <agent adresi>   # SQUARE_DEMO_A2A_KEY
pnpm --filter @squaresdk/solana-demo agent --config <küme.json> [--port 8787] [--host 127.0.0.1] [--institution <adres>]
pnpm --filter @squaresdk/solana-demo demo:localnet [--deploy-dir target/deploy] [--ledger <dizin>] [--rpc-port 8899] \
  [--faucet-port 9900] [--gossip-port 8001] [--dynamic-port-range 8100-8200] [--scenario <ad>]... [--out <sonuç.json>]
pnpm --filter @squaresdk/solana-demo test                                 # zincirsiz birim testleri
```

Yapılandırma `--config` ya da `SQUARE_DEMO_CONFIG` ile verilir. `scenario` ve `demo:localnet` ispatı süreç içinde üretir
(smoke'un prover'ı): devrenin wasm'ı önce derlenir, `circuits/payment-compliance/scripts/ci-build.sh`
([smoke README](../../tests/smoke/README.md)).

## Seed

Her adım önce zinciri okur ve yalnızca eksik olanı yazar. İkinci koşu aynı kurulumu bulur ve tx göndermez; senaryolar
bakiyeleri harcadıysa onları hedefe tamamlar.

| Adım | Ne kurulur | Tekrar koşuda |
|---|---|---|
| SOL | `payer`'dan agent'a ve keeper'a `funding.agentLamports` / `funding.keeperLamports` hedefine kadar SOL. Agent kendi tx ücretlerini öder (kabul, teslim, listeleme, kayıt) | Hedefteyse dokunulmaz; kayıt ücretinden sonra hedefe yeniden tamamlanır |
| Devnet USDC dağıtımı | `payer`'ın settlement token hesabından kuruma ve alıcıya `funding.institutionUsdc` / `funding.buyerUsdc` hedefine kadar `transferChecked` (ATA'lar idempotent açılır); keeper'ın token hesabı | Hedefteyse dokunulmaz. `payer`'ın bakiyesi yetmezse koşu durur ve faucet'i söyler |
| Screening | Kurum, agent ve alıcı cüzdanları için `record_screening` (`Clear`), imzacı screener authority. `source_hash`, `{ source: "square-demo-seed", version, cluster, role, wallet }` belgesinin RFC 8785 + SHA-256'sıdır | Süresi `screening.minRemainingSecs`'ten fazla kalan temiz kayıt yeniden yazılmaz; `Flagged` kayıtta koşu durur |
| Kurum | `initInstitution(institutionName)`, yetkili kurum anahtarı | Varsa dokunulmaz (Squads'a bağlı kurum reddedilir) |
| Politikalar ve alıcı listesi | Her politika için `setPolicy` (yoksa) ya da `updatePolicy` (commitment veya public tavan değiştiyse), ardından `setBuyerRoot`. Politika kimliği `SHA-256("square-demo/policy/<ad>")`, salt'lar politika sırrından (`policySecret`). Alıcı listesi `buyer` ve `extraBuyers`; yaprak salt'ı sırdan türer, kök her koşuda aynıdır | Commitment, tavan ve kök zincirdekiyle aynıysa tx yok |
| Agent kaydı | Demo agent'ın kartıyla agent-sdk `register()` (kart agent'ın kendi adresinde, `register_agent`) | Kart, adres ve cüzdan aynıysa `unchanged` |

- **Politika sırrı:** `seed.policySecret` dosyası yoksa üretilir (32 bayt hex, `0600`, üstüne yazılmaz); CLI'nin
  `policy secret` biçimidir, `squaresdk-solana --secret` de okur. Depo içindeki yol reddedilir. Sır kaybolursa yeni sırla
  commitment değişir ve seed politikayı `updatePolicy` ile yeni sürüme taşır.
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
- **Spec:** `{ "capability": "solana.account-report", "accounts": [<1-8 adres>], "signatures": <0-10, varsayılan 5>,
  "request": "<koşu kimliği>" }`. Geçersiz spec `accept_job`'dan önce reddedilir (`admit`); job fonlu kalır.
- **Rapor:** her hesap için tür (`wallet`, `tokenAccount`, `mint`, `program`, `square`, `other`, `missing`), lamport ve
  SOL, sahip program ve adı (System, SPL Token, Token-2022, yükleyiciler, dört Square programı), rent muafiyeti, token
  hesabında mint / sahip / tutar (mint'in ondalığıyla), mint'te arz ve yetkililer, Square hesabında IDL discriminator'ından
  hesap tipi (`Job`, `AgentRecord`, `Policy` ...), son imzalar (sayı, başarısız sayısı, en yeni slot ve zaman); özet:
  türlere göre sayılar, toplam SOL, mint başına token toplamları.
- **Teslimat:** `application/json`. Agent içeriği SHA-256'sıyla saklar ve `${publicUrl}/deliveries/<sha256>` yolundan
  sunar; agent-sdk makbuzu içerikle karşılaştırır, `submit_work`'e bu hash ve adres gider. Teslimat adresi 128 baytı
  aşmamalı: `publicUrl` en fazla 52 karakterdir.
- **A2A ve görev deposu:** Kurumun anahtarı `x-api-key` ile gelir; agent yalnızca anahtarın SHA-256'sını ve yetkili kurum
  cüzdanını tutar. Görevler bellekteki depodadır (`src/memory-store.ts`, `TaskStore` arayüzü); süreç yeniden başlarsa
  yarım kalan görev sürdürülmez. Kalıcı depo gereken dağıtımda agent-sdk'nın Postgres deposu kullanılır.
- **Alacak:** `demo.agent.autoListClaimBps` verilirse agent teslimden sonra alacağı bu indirimle listeler (`list_claim`).

## Senaryolar

`demo.scenarios` altındaki her senaryo bir ispat varyantıdır: `expect` `approved` ya da `refused`. Koşucu kurum ve keeper
rolündedir; agent tarafındaki her tx'i agent kendisi imzalar.

| Adım | Koşucunun yaptığı | Zincirden doğrulanan |
|---|---|---|
| Ön koşul | Politikayı sırdan kurar, agent'ın kartını indirir | Commitment zincirdekiyle aynı; kartın SHA-256'sı `agent_card_hash` |
| 3 | `createJob` (politikalı) + `fundJob` | Vault'ta tutar, kurumdan düştü |
| 4 | A2A `SendMessage`, görev bitene kadar `GetTask` | Görev `COMPLETED`; job `Delivered`; makbuz, `work_hash` ve `delivery_uri` aynı; teslimatın SHA-256'sı `work_hash`; agent aynı baytları sunuyor; rapor bu job'un |
| 5 | `claimSale: true` ise agent'ın listelediği alacağı seed'deki alıcı listesinin Merkle kanıtıyla alır | Listeleme `Bought`, agent fiyatı aldı |
| 7 | Groth16 ispatı süreç içinde, `setComplianceProof` | `approved`: uyumlu, payee agent (satıldıysa alıcı), net tutar; `refused`: ret kodu ve kesin ret |
| 6 + 8 | Challenge bitince `finalizePayment` (keeper); başka bir keeper önce kapattıysa yalnızca okur | `approved`: `Released`, `ValidationRecord` `Verified`, payee'ye net, keeper'a ücret; `refused`: `Refunded`, net kuruma |

Ret varyantı, işlem başı tavanı job tutarının altında olan bir politikayla kurulur: ret kodu `perTx`, kesin rettir ve
escrow kuruma iade edilir. Ret senaryosunda alacak satılmaz (iadede alıcıya ödeme yapılmaz). Tutar Travel Rule eşiğinin
altında olmalıdır.

## Yapılandırma

Dosya smoke'un küme yapılandırmasıdır ([alanlar](../../tests/smoke/README.md#küme-yapılandırması)); `seed` ve `demo`
bölümleri eklenir. Aynı dosya smoke'un `init` ve `smoke` komutlarıyla da kullanılır. Anahtar içerikleri dosyada ve depoda
bulunmaz; göreli yollar dosyanın dizinine göre çözülür. Demonun istediği anahtarlar: `payer`, `institution`, `agent`,
`buyer`, `keeper`; `screener` yalnızca yazılacak screening kaydı varsa.

| Alan | Açıklama |
|---|---|
| `seed.institutionName` | Kurumun zincirdeki adı (en fazla 64 bayt) |
| `seed.policySecret`, `seed.output` | Politika sırrının yolu (repo dışı), seed çıktısının yolu (isteğe bağlı) |
| `seed.policies.<ad>` | `maxPerTx`, `maxDaily`, `dailyCeiling` (settlement mint'in atomik birimi), `categories`. Ad `[a-z0-9-]`, en fazla 8 politika |
| `seed.extraBuyers` | Alıcı listesine `buyer`'ın yanında eklenen adresler (en fazla 15) |
| `seed.funding` | `institutionUsdc`, `buyerUsdc` (token hedefleri), `agentLamports`, `keeperLamports` (SOL hedefleri) |
| `seed.screening.minRemainingSecs` | Kaydın yeniden yazılması için kalan süre eşiği |
| `demo.agent` | `agentId` (registry `agent_id`), `name`, `description`, `version`, `publicUrl` (https, en fazla 52 karakter), `price`, `autoListClaimBps` (isteğe bağlı, 1-9999) |
| `demo.taskTimeoutSecs` | A2A görevinin bitmesi için en uzun bekleme (varsayılan 180) |
| `demo.scenarios.<ad>` | `policy` (seed'deki ad), `expect` (`approved` / `refused`), `amount` (agent'ın fiyatından az olamaz), `paymentCategory`, `challengePeriodSecs`, `deadlineSecs`, `claimSale` (varsayılan `false`), `report.targets` (rol: `payer`, `institution`, `agent`, `buyer`, `keeper`; rolün token hesabı: `<rol>:usdc`; `institution:pda`; `mint`; ya da adres), `report.signatures` |

## Localnet

```bash
pnpm --filter @squaresdk/solana-demo demo:localnet --deploy-dir target/deploy --rpc-port 38899 --faucet-port 39900 \
  --gossip-port 38001 --dynamic-port-range 38100-38200 --out /tmp/demo-localnet.json
```

Programlar `target/deploy/*.so`'dan yüklenir (derlenmez). Rol anahtarları, upgrade authority ve 6 ondalıklı mint koşu için
geçici bir dizinde üretilir; faucet yerine `payer`'a 1 000 USDC basılır ve seed oradan dağıtır. Localnet yapılandırması
([`src/localnet.ts`](src/localnet.ts)): `standard` (işlem başı 10 USDC) ve `strict` (işlem başı 1 USDC) politikaları,
üç alıcılı liste, agent fiyatı 1 USDC, `autoListClaimBps` 300 ve üç senaryo:

| Senaryo | Politika | Tutar | Sonuç |
|---|---|---|---|
| `approved` | `standard` | 5 USDC | ispat uyumlu, `Released`, agent'a 4,975 USDC |
| `approved-claim` | `standard` | 4 USDC, alacak satışı | alıcı 3,88 USDC'ye alır; ispat uyumlu, `Released`, alıcıya 3,98 USDC |
| `refused` | `strict` | 5 USDC | ret kodu 1 (`perTx`), `Refunded`, kuruma 4,975 USDC |

Çıktı: iki seed satırı (ilki değişiklik sayısı, ikincisi `0 değişiklik`) ve senaryo başına bir satır; `--out` bütün
sonucu (seed çıktıları, senaryoların job, görev, teslimat, rapor, ispat ve ödeme ayrıntıları, tx imzaları) JSON olarak
yazar. Validator ve agent koşu sonunda kapanır; hata olursa validator günlüğünün yolu yazılır.

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
2. **Screener authority:** Screening kaydını yalnızca registry config'indeki authority
   (`48DGxja6FefZHhZ8e5ynLKWLqxb1pVfiHFUVg1Jrm54b`) yazar; anahtar secret store'dadır. İki yol var:
   - Anahtar koşu süresince `keys/screener.json` olarak verilir; seed üç cüzdanı demo kanıt belgesiyle `Clear` yazar.
   - Ya da cüzdanlar önce OFAC listesine karşı taranır: screener servisi (`POST /v1/screenings`) ya da
     [screener runbook'u](../../docs/runbooks/screener.md) (`scripts/deploy/record-screening.mjs`). Seed taze temiz kaydı
     yeniden yazmaz, `keys.screener` verilmez.
3. **SOL:** `payer` ücretleri, rent'i ve agent ile keeper'ın SOL'ünü öder; en az 1 SOL:

   ```bash
   solana airdrop 2 $(solana-keygen pubkey ~/square-devnet/keys/payer.json) -u devnet
   ```

   RPC sınırına takılırsa <https://faucet.solana.com>.
4. **Devnet USDC:** Circle'ın devnet mint'i `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. <https://faucet.circle.com>
   ("Solana Devnet") ile **payer'ın** adresine en az `funding.institutionUsdc + funding.buyerUsdc` gönderilir; seed kuruma
   ve alıcıya dağıtır.
5. **Yapılandırma:** `~/square-devnet/demo.json`. Küme alanları devnet kaydınınkiler, `keys` yolları `keys/<rol>.json`.
   Challenge süresi devnet'te en az 60 sn, Travel Rule eşiği 1 000 USDC'dir:

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
       "screener": "keys/screener.json",
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
         "standard": { "maxPerTx": "2000000", "maxDaily": "20000000", "dailyCeiling": "50000000", "categories": ["research"] },
         "strict": { "maxPerTx": "500000", "maxDaily": "20000000", "dailyCeiling": "50000000", "categories": ["research"] }
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
         "autoListClaimBps": 300
       },
       "scenarios": {
         "approved": { "policy": "standard", "expect": "approved", "amount": "1000000", "paymentCategory": "research", "challengePeriodSecs": 60, "deadlineSecs": 3600, "report": { "targets": ["institution", "institution:usdc", "mint"] } },
         "approved-claim": { "policy": "standard", "expect": "approved", "amount": "1000000", "paymentCategory": "research", "challengePeriodSecs": 60, "deadlineSecs": 3600, "claimSale": true, "report": { "targets": ["buyer", "buyer:usdc", "agent:usdc"] } },
         "refused": { "policy": "strict", "expect": "refused", "amount": "1000000", "paymentCategory": "research", "challengePeriodSecs": 60, "deadlineSecs": 3600, "report": { "targets": ["agent", "keeper"] } }
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

   Ya da agent erişilebilir bir sunucuda tek başına çalışır ve koşucu ona bağlanır; iki taraf aynı A2A anahtarını kullanır:

   ```bash
   export SQUARE_DEMO_A2A_KEY=$(openssl rand -hex 32)
   pnpm --filter @squaresdk/solana-demo agent --config ~/square-devnet/demo.json --host 0.0.0.0 --port 8787
   pnpm --filter @squaresdk/solana-demo scenario --config ~/square-devnet/demo.json --agent-url <agent'ın adresi>
   ```

   Her senaryo challenge penceresini (60 sn) bekler. Devnet'te keeper servisi (BE-15) çalışıyorsa finalize'ı o yapabilir;
   koşucu bunu görür ve yalnızca sonucu doğrular. Gün dönümüne yakın koşuda ispat ertesi güne bırakılır
   ([ADR 0012](../../docs/decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md)).
8. **Kayıt:** Seed çıktısı ve senaryo sonucu (job'lar, imzalar, teslimat hash'leri) devnet kaydına işlenir.

## Dosyalar

| Dosya | İçerik |
|---|---|
| [`src/demo-config.ts`](src/demo-config.ts) | `seed` ve `demo` bölümlerinin şeması; küme alanları smoke'un şemasıyla |
| [`src/seed.ts`](src/seed.ts) | Seed adımları ve çıktısı |
| [`src/policies.ts`](src/policies.ts) | Politika sırrı, politika kimlikleri ve belgeleri, alıcı ağacı |
| [`src/report.ts`](src/report.ts) | Agent'ın işi: spec doğrulaması, hesap raporu, agent-sdk işleyicisi |
| [`src/agent.ts`](src/agent.ts), [`src/delivery.ts`](src/delivery.ts), [`src/memory-store.ts`](src/memory-store.ts) | Demo agent'ı, teslimat deposu ve sunucusu, bellekteki görev deposu |
| [`src/scenario.ts`](src/scenario.ts) | Senaryo koşucusu |
| [`src/cli.ts`](src/cli.ts), [`src/localnet.ts`](src/localnet.ts) | Komutlar ve localnet koşucusu |

Birim testleri zincirsizdir. Zincirle çalışan akışlar (`seed.ts`, `scenario.ts`, komutlar ve localnet koşucusu)
`demo:localnet` koşusunda gerçek işlemlerle sınanır ve kapsam ölçümünün dışındadır.

## Kalan

- Devnet koşusu yapılmadı: anahtarlar (payer, screener authority ya da önceden tarama) bu işin koşusunda yoktu. Adımlar
  yukarıda; koşu kaydı devnet kaydına yazılır.
- Agent'ın Railway'de dağıtımı ve sağlık uçları BE-20'dedir. Teslimatlar ve görevler agent'ın belleğindedir; dağıtımda
  Square API'sinin teslimat ucu (`api` seçeneği) ve Postgres görev deposu kullanılabilir.
- Seed'in screening kaydı OFAC taraması değildir; demonun kanıt belgesini taşır. Gerçek tarama screener servisinin ya da
  runbook'un işidir (adım 2).
