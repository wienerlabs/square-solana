# API ve SDK sözleşmesi

**Sözleşme sürümü:** v0.5.2 (taslak) · **Issue:** BE-35 (#102), BC-47 (#119), BE-07 (#39), BE-08 (#40), BE-09 (#41), BE-10 (#42), BE-11 (#44), BC-02 (#2) · **Dayandığı program sözleşmesi:** BC-44 v0.2.0 ([program-interface.md](program-interface.md))

Bu doküman Square'in HTTP API'sini ve TypeScript paketlerinin dış yüzeyini sabitler. Frontend (FE-24 veri katmanı) ve servisler (BE-18 API, BE-14 indexer, BE-15 keeper, BE-11 prover) bu sözleşmeye göre geliştirir. `@squaresdk/solana-sdk`'nin zincir tarafı BE-08, `@squaresdk/solana-identity` BE-09, `@squaresdk/solana-policy` BE-10 ile uygulandı; REST client'ın uygulaması BE-18'de. Paketlerde mock, placeholder gövde ya da sabit adres yoktur (proje kuralı).

## 1. Dosyalar

| Yol | İçerik | Uygulayan issue |
|---|---|---|
| [`docs/api/openapi.yaml`](../api/openapi.yaml) | OpenAPI 3.1 spec (28 operasyon) | BE-18 |
| [`docs/api/schemas/idl.json`](../api/schemas/idl.json) | IDL'den **üretilen** JSON Schema'lar (hesaplar, event'ler, instruction argümanları) | — |
| `packages/types` → `@squaresdk/solana-types` | zod şemaları: zarf, görünümler, agent card, policy dokümanı, A2A görevi, event, tx, auth, prover, keeper | BE-07 |
| `packages/sdk` → `@squaresdk/solana-sdk` | 4 program için client, PDA'lar, tx builder'lar, 8 adım akışı, event / hata yardımcıları, REST API client | BE-08, BE-18 |
| `packages/identity` → `@squaresdk/solana-identity` | did:aip çözümleyici, DID Document, agent card doğrulama | BE-09 |
| `packages/policy` → `@squaresdk/solana-policy` | Politika commitment'ı, alıcı Merkle ağacı, release witness'ı, prover, ispat bağlama | BE-10 |
| `.github/workflows/contract.yml` | Hizalama CI'ı | BE-03 / BC-13 devralabilir |

**Yayımlama:** Sözleşme, `main`'deki sürümlü dosyalardır. `pnpm openapi:docs` tek dosyalık HTML belge üretir (`dist/api/index.html`, commit'lenmez). Paketler şimdilik `private`; npm'e yayın ayrı bir karar.

## 2. BC-44 IDL'iyle hiza

Hiza dört katmanda kurulur, hepsi CI'da denetlenir:

| Katman | Nasıl | Denetim |
|---|---|---|
| Zincir verisinin JSON şemaları | `packages/types/scripts/gen-idl-schemas.mjs` `idl/*.json`'dan zod (`src/generated/idl.ts`) ve JSON Schema (`docs/api/schemas/idl.json`) üretir. Hesaplar, event'ler, tipler, instruction argümanları, `InstructionCall` ve `ProgramEventPayload` birleşimleri | `pnpm --filter @squaresdk/solana-types gen:check` |
| SDK'nın zincir tipleri | `packages/sdk/scripts/gen-idl-types.mjs`, `idl/*.json`'un kopyasını ve Anchor CLI ile aynı dönüşümle camelCase TS tip dosyasını `packages/sdk/src/idl/`'a yazar (çıktı Anchor'ınkiyle bayt bayt aynı). `IxArgs`, `IxAccounts`, hesap tipleri ve `InstructionBuilders` bu tiplerden türetilir; elle tip yazılmaz | `pnpm --filter @squaresdk/solana-sdk gen:check`, `test/contract.test.mjs` (JSON birebir), `type-tests/ix-args.ts` (`tsc --noEmit`) |
| Elle yazılan API şemaları | Görünümler ve işlem şemaları hem zod'da hem OpenAPI'de yazılıdır | `packages/types/test/openapi-alignment.test.mjs`: alan adları, zorunlu alanlar, enum'lar |
| REST client ↔ spec | `SquareApi` metot adları = OpenAPI `operationId`'leri | Tip düzeyi (`API_OPERATIONS`) + `packages/sdk/test/contract.test.mjs` |

**Program sözleşmesi değişince:**
1. `idl/*.json`'u değiştir.
2. `pnpm --filter @squaresdk/solana-types gen` ve `pnpm --filter @squaresdk/solana-sdk gen` ile türetilen dosyaları yeniden üret.
3. Gerekiyorsa elle yazılan görünümleri ve OpenAPI'yi güncelle, `pnpm contract:check && pnpm test` çalıştır.
4. İki dokümanın değişiklik kaydına sürüm notu düş.

## 3. JSON kodlaması

API, indexer ve SDK'nın JSON yüzeyi için tek kural (üretecin başlığında da yazılı):

| IDL tipi | JSON | Not |
|---|---|---|
| `pubkey` | base58 string | `Address` |
| `u64`, `u128` | ondalık string | `U64`; JS `number` hassasiyetini aşmamak için |
| `i64` | integer | Sözleşmede yalnızca unix saniyesi ve süreler; güvenli tamsayı aralığında |
| `u8`…`u32`, `i8`…`i32` | integer | Aralık kontrolüyle |
| `bool`, `string` | aynen | |
| `[u8; N]` | küçük harf hex (2N karakter) | 32 bayt için `Hex32` |
| `[T; N]`, `vec<T>` | dizi | |
| `option<T>` | `T` ya da `null` | |
| veri taşımayan enum | camelCase string | ör. `JobStatus` → `"delivered"` |
| veri taşıyan enum | `kind` alanıyla ayrılan nesne | ör. `{ "kind": "split", "agentAmount": "500000" }` |
| alan adları | camelCase | Anchor TS ile aynı |

Görünümler zincir hesabını `account` alanında üretilen şemayla **aynen** taşır. Görünüm yalnızca adres, türetilmiş alanlar (`payee`, `did`, `cardVerified`, `fresh`) ve tazelik bilgisi (`slot`, `indexedAt`) ekler.

SDK ise Anchor TS tiplerini kullanır: `PublicKey`, `BN`, `number[]`. JSON ile SDK arasındaki dönüşüm BE-08'de uygulanır.

## 4. Yanıt zarfı ve hatalar

Tüm `/v1` yanıtları `{ success, data, error, meta }` biçimindedir. `meta.requestId` her zaman doludur; `page`, `limit` ve `total` yalnızca sayfalı yanıtlarda doludur. İstisnalar: `/health`, `/ready` ve A2A keşif yolu `/a/{agentRecord}/.well-known/agent-card.json` zarfsız döner.

`error.code` değerleri `ApiErrorCode` listesindedir. Zincir hataları `program_error` ya da `simulation_failed` koduyla döner ve `error.programError = { program, code, name }` taşır. Program hata kodları her programda 6000'den başladığı için hata yalnızca **(program, code)** çiftiyle eşlenir. Kodlar ve adlar `IDL_PROGRAMS[program].errors` içindedir.

## 5. Uç noktalar

| Etiket | Operasyonlar | Yetki |
|---|---|---|
| auth | `createAuthChallenge`, `createSession`, `deleteSession`, `listApiKeys`, `createApiKey`, `deleteApiKey` | Cüzdan Ed25519 imzası → oturum; API anahtarları oturumla yönetilir |
| jobs | `listJobs`, `getJob`, `uploadDelivery` | Okuma açık; teslimat oturum ya da anahtarla |
| policies | `getInstitution`, `listPolicies`, `getPolicy`, `putPolicyMeta` | Meta yazımı kurumun güncel yetkilisi |
| agents | `listAgents`, `getAgent`, `putAgentCard`, `getWellKnownAgentCard` | Kart barındırma kayıt sahibi |
| claims / disputes | `listClaims`, `getClaim`, `listDisputes`, `getDispute` | Açık |
| screening / events / keeper | `getScreening`, `listEvents`, `listKeeperActions` | Açık |
| tx | `prepareTx` | Oturum ya da anahtar (`tx:prepare`) |
| prover | `prove` | Anahtar (`prove`) |
| health | `getHealth`, `getReady` | Açık |

**`POST /v1/tx`:** `call` alanı IDL'den üretilen `InstructionCall` birleşimidir: program, camelCase instruction adı ve IDL kodlamasıyla argümanlar. PDA'lar sunucuda IDL'deki seed bilgisinden çözülür. `accounts` yalnızca türetilemeyen hesapları (imzacılar, dış hesaplar, token hesapları) IDL hesap adıyla taşır. Yanıt imzasız v0 tx'tir; tx imzalanıp doğrudan RPC'ye gönderilir.

**Prover güven sınırı:** `POST /v1/prove` witness'ı, yani politikanın kendisini alır; servisi işleten taraf politikayı görür. Kurum ya kendi prover'ını çalıştırır ya da `@squaresdk/solana-policy`'nin in-process proving'ini kullanır.

## 6. Sekiz adım → SDK ve API

| # | Adım | SDK | API |
|---|---|---|---|
| 1 | Politika commitment'ı | policy: `generatePolicySecret`, `derivePolicySalts`, `computePolicyCommitment`; sdk: `policy.instructions.setPolicy` | `prepareTx` (`setPolicy`), `putPolicyMeta` |
| 2 | Agent kaydı | sdk: `flow.registerAgent`; identity: `formatDidAip` | `putAgentCard`, `prepareTx` (`registerAgent`) |
| 3 | Screening + iş açma + fonlama | sdk: `flow.createJob`, `flow.fundJob`, `specHash` | `getScreening`, `prepareTx` (`createJob`, `fundJob`) |
| 4 | Kabul ve teslim | sdk: `flow.acceptJob`, `flow.submitWork` | `uploadDelivery`, `prepareTx` (`acceptJob`, `submitWork`) |
| 5 | Alacak satışı | policy: `buildBuyerTree`, `getBuyerProof`; sdk: `flow.listClaim`, `flow.buyClaim` | `listClaims`, `prepareTx` (`setBuyerRoot`, `listClaim`, `buyClaim`) |
| 6 | Permissionless finalize | sdk: `flow.finalizePayment` | `listKeeperActions`, `prepareTx` (`finalizePayment`) |
| 7 | Release ispatı | policy: `buildReleaseWitness`, `createLocalProver` / `createRemoteProver`, `buildSetComplianceProofTx`, `watchJobProof` | `prove`, `prepareTx` (`setComplianceProof`) |
| 8 | Ödeme, itibar, validation | sdk: `decodeEvents`, `escrow.fetch` | `getJob` (`releaseProof`, `validation`), `listEvents`, `getAgent` (`reputation`) |
| — | Dispute | sdk: `flow.raiseDispute`, `flow.resolveDispute`, `flow.executeResolution` | `listDisputes`, `getDispute`, `prepareTx` |

## 7. Kararlar

| Konu | Karar | Gerekçe |
|---|---|---|
| TypeScript | `~5.9.3` | Solana paketleri (`@solana/errors` vb.) peer olarak `typescript ^5` bekliyor; 6.x uyarı veriyor, 7.x yeni Go derleyicisi. `tsconfig.base.json` `types: ["node"]` ile TS 6'ya da hazır |
| Şema kütüphanesi | zod 4 | Aperture `@aperture/types` zod kullanıyor (BE-07 birleştirmesi) |
| OpenAPI aracı | `@redocly/cli` 2 | 3.1 lint + tek dosya HTML; `redocly.yaml`, istisnalar `.redocly.lint-ignore.yaml`'da gerekçesiyle |
| Anchor TS / web3.js | `@coral-xyz/anchor` 0.31.1, `@solana/web3.js` 1.x | Anchor CLI 0.31.1 ile aynı hat; sürüm birleştirme BC-08'de, `@solana/kit` geçişi BE-08'in kararı |
| Native hızlandırıcılar | `bufferutil`, `utf-8-validate` kurulum script'leri çalıştırılmaz (`pnpm-workspace.yaml`) | İsteğe bağlı; JS yedekleri var. Kalan `utf-8-validate` peer uyarısı ve `uuid@8` deprecation'ı web3.js 1.x'in dolaylı bağımlılıklarından |
| Node | `engines.node >= 24` | Node 24 LTS hattı (BC-43 `.nvmrc` ile aynı) |
| Testler | vitest; YAML ayrıştırma için yalnızca test bağımlılığı `yaml`. SDK'da kapsama eşiği %80 (`vitest run --coverage`) | BE-08 kabul kriteri; eşik altı CI'ı kırar |
| Spec hash | RFC 8785 kanonikleştirme SDK'da yazılı, girdi önce I-JSON olarak denetlenir (sonlu olmayan sayı, tek başına surrogate, `undefined`, fonksiyon, düz olmayan nesne reddedilir); SHA-256 `@noble/hashes` | `canonicalize` paketi JSON olmayan değerleri sessizce geçiriyor ve tip bildirimi CJS çıktısıyla uyuşmuyor; RFC'nin test vektörleri testte |
| Tx hesapları | 8 adımın builder'ları hesapları `accountsStrict` ile tamamen açık verir; PDA'lar `createPda`'dan, payee / mint / rent ödeyicisi zincirdeki job ve alacak kaydından, token programı mint'in sahibinden (SPL Token ya da Token-2022) | Anchor'ın çözücüsü çapraz program seed'leri için zincirden config okurdu; açık hesaplar IDL'e derleme zamanında bağlı |
| Token hesapları | Ödeme alan tarafların (payee, kurum, alacak satıcısı) ATA'sı aynı tx'te idempotent açılır; ödeyici tx'i gönderen (keeper / çağıran / fee payer) | Settlement, alıcının hesabı yok diye düşmez |
| Poseidon (policy) | `poseidon-lite` (MIT), circomlib parametreleri | Devrenin `Poseidon(n)`'i ile 14 senaryoda bayt bayt aynı (`packages/policy/test/circuit-vectors.test.ts`); circomlibjs GPL-3.0 |
| snarkjs (policy) | Paketin bağımlılığı değil; `createLocalProver` çağıranın kurduğu `groth16` nesnesini alır (`Groth16Backend`). Paket testlerde dev bağımlılığı olarak kullanır | snarkjs GPL-3.0 (`scripts/license/policy.mjs`'te "review"); Apache-2.0 paket onu dağıtmaz |
| Politika salt'ları | Kurum tek bir 32 baytlık sır saklar; 8 yaprağın salt'ı `sha256("square/policy-salt/v1" ‖ sır ‖ policyId ‖ i) mod r` | Yedeklenecek tek değer; aynı sır farklı politikalarda farklı salt verir |
| Compute budget / ALT | `BuildOptions`'taki değerler yalnızca verilirse eklenir; SDK varsayılan CU sayısı uydurmaz. Ölçülmüş profiller BC-28'de | Proje kuralı (sabit değer yok) |

## 8. Açık noktalar

1. **A2A eşlemesi (BE-17):** `JOB_STATUS_TO_TASK_STATE` taslaktır. Örneğin `disputed → input-required` ve `refunded → failed` eşlemeleri BE-17'de kesinleşir.
2. **Agent card (BC-14, BE-09):** Tek şema v0.3.0'da kesinleşti: kart hem ERC-8004 kayıt dosyası (`type`, `services`, `registrations`, `active`) hem A2A AgentCard'ıdır; DID çözücüsü servisleri `services`'ten üretir ([did:aip Solana profili](../did-aip/method-spec-v2-solana.md) §5.4–§5.5). Devirde cüzdanın yeni sahibe sıfırlanması kuralı program sözleşmesine BC-15 ile eklenecek.
3. **Policy dokümanı (BE-10):** `PolicyDocument` v0.2.0'da release devresinin politika girdilerine hizalandı (BE-07, [release-circuit.md](release-circuit.md) §4–§5): yuva sınırları `POLICY_CIRCUIT_LIMITS`, tek UTC penceresi, gün adları devrenin maske sırasıyla. Alanların alan elemanlarına çevrilmesi ve commitment `normalizePolicy` / `computePolicyCommitment`'tadır (BE-10); `circuits/payment-compliance/scripts/release-input.mjs`'in 14 senaryosuyla bayt bayt aynı olduğu CI'da denetlenir.
4. **Auth (BE-18):** İmzalanan mesajın metni (alan adı ve süre) ve oturum belirteci biçimi BE-18'de belirlenir. Sözleşme yalnızca alanları sabitler.
5. **Prover servisi (BE-11):** `apps/prover` `POST /v1/prove`'u bu sözleşmedeki istek, yanıt, zarf ve `x-api-key` ile birebir sunar; kendi OpenAPI'si `GET /openapi.json`'dadır ([apps/prover/README.md](../../apps/prover/README.md)). `createRemoteProver` doğrudan servise ya da API'ye bağlanabilir. API'nin `/v1/prove`'u servise vekil mi olacak, ayrı mı kalkacak: BE-18'in kararı.
6. **Tx boyutu (BC-28):** `setComplianceProof` için ALT gerekebilir (program sözleşmesi §8.9); `UnsignedTx.addressLookupTables` bunun için var.

## 9. Sözleşme değişiklik kaydı

**Sürümleme:** `MAJOR.MINOR.PATCH`. 1.0.0'a kadar geriye uyumsuz her değişiklik MINOR'u artırır: uç nokta, alan, enum değeri ya da fonksiyon imzası. BC-44 program sözleşmesindeki bir MINOR artış, üretilen şemalar üzerinden bu sözleşmenin de MINOR'unu artırır. Her değişiklik aynı PR'da spec'i, zod şemalarını, imzaları ve bu tabloyu günceller. `API_CONTRACT_VERSION` (`@squaresdk/solana-types`) sürümle aynı tutulur.

| Sürüm | Değişiklik | Issue / PR |
|---|---|---|
| v0.1.0 | İlk taslak: 28 operasyonluk OpenAPI 3.1 spec; IDL'den üretilen zod ve JSON Schema'lar; 4 paketin gövdesiz imzaları; hizalama testleri ve CI | BE-35 (#102) |
| v0.5.2 | OpenAPI `info.license` repo lisansına (`LICENSE`, `NOTICE`) hizalandı: `MIT` yerine `Apache-2.0`, `name` ve SPDX `identifier` aynı değer. Yalnızca spec metadata'sı; HTTP yüzeyi, şemalar ve imzalar değişmedi. `openapi-alignment.test.mjs` artık `info.version`'ı `API_CONTRACT_VERSION` ile, `info.license`'ı kök `package.json` lisansıyla karşılaştırır | BC-02 (#2) |
| v0.5.1 | `POST /v1/prove` 409 `conflict` döner: `artifactVersion` prover'da yüklü zkey'in SHA-256'sı değilse (`details.expected` doğru sürüm). Yanıt bileşeni `Conflict`. Prover servisi (`apps/prover`) aynı uç noktayı sunar | BE-11 (#44) |
| v0.5.0 | `@squaresdk/solana-policy` uygulandı (BE-10); `SquarePolicyKit` arayüzü yerine fonksiyonlar dışa aktarılır. Değişen imzalar: `generatePolicySalt` → `generatePolicySecret` + `derivePolicySalts` (yaprak başına 8 salt, `PolicySalts`); `computePolicyCommitment(policy, salts)`; `buildReleaseWitness` `connection` yerine client'ın bağlantısını kullanır, `salts` ve `paymentCategory` alır; `createLocalProver` `groth16` backend'ini, `createRemoteProver` beklenen `artifactVersion`'ı alır; `watchJobProof` `paymentCategory`, `authority`, `buildOptions`, `intervalMs`, `refreshBeforeSecs` alır ve `onError` zorunlu. `NormalizedPolicy` devrenin politika girdileridir. HTTP yüzeyi değişmedi | BE-10 (#42) |
| v0.4.0 | Program sözleşmesi v0.2.0'a dayanır (`set_compliance_proof` yol A, alıcı Merkle kuralı). `ProveResponse.publicInputs` 10 yerine release devresinin 13 sinyali | BE-10 (#42) |
| v0.3.0 | `AgentCard` tek şema: ERC-8004 kayıt dosyası alanları eklendi (`type` zorunlu, `services` zorunlu ve `url` ile aynı uç noktalı bir `A2A` girdisi içerir, `active`, `x402Support`), `AgentService` bileşeni. `@squaresdk/solana-identity` arayüzü did:aip Solana profiline hizalandı: `ParsedDidAip` v2 Solana / v2 EVM / v1 birleşimi, `DidDocument.capabilityInvocation`, spesifikasyonun çözüm metadata'sı (`versionId`, `agentStatus`, `deactivation`, `agentCard`, `crossRegistrations`, v1 `deprecated` …), hata kodları ve uyarılar, `ResolverOptions.connections` / `card` / `crossRegistrationLimit`; uygulama `squareIdentity` | BE-09 (#41) |
| v0.2.1 | SDK zincir tarafı uygulandı (BE-08): `createSquareClient` (4 program client'ı, IDL builder'ları, `buildTx`, `decodeEvents`, `mapError`, 8 adımın `flow` builder'ları), `createPda`, `specHashing`, `workHash`. Yalnızca ekleme; imzalar değişmedi | BE-08 (#40) |
| v0.2.0 | `PolicyDocument` release devresine hizalandı: `institution`, gizli `maxDaily` eklendi; `maxPerPayment` → `maxPerTx`, `mintWhitelist` → `tokenWhitelist` (≤ 10), `blockedPayees` ≤ 10, `allowedCategories` 1–8 (her biri 1–32 bayt UTF-8), `timeWindows` → tek `timeWindow` (UTC, gün adları, `start ≤ end`); devrede karşılığı olmayan `allowedAgentRecords` çıktı. `AipV1AgentCardSchema` (did:aip v1 kartı, AIP'den). Veritabanı enum'ları bu şemalarla testte hizalı (BE-04). HTTP yüzeyi değişmedi | BE-07 (#39) |
| v0.1.1 | Placeholder'lar kaldırıldı (proje kuralı): `NotImplementedError` ve onu fırlatan gövdeler, `SOURCE_PROGRAM_IDS`, OpenAPI'deki `localhost` sunucusu ve `not_implemented` hata kodu çıktı. sdk / identity / policy yalnızca tip ve arayüz (`SquareClient`, `SquareApi`, `SquarePda`, `SpecHashing`, `SquareIdentity`, `SquarePolicyKit`, `Create*` fabrika tipleri) sunar; `SquareClientConfig.programIds` zorunlu. SDK IDL tipleri `idl/*.json`'dan üretilir | BC-47 (#119) |
