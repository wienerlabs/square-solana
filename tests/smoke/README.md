# tests/smoke — küme kurulumu ve uçtan uca smoke

**Issue:** BC-30 (#38) devnet deploy + init, BC-31 (#43) devnet uçtan uca smoke ·
**Paket:** `@squaresdk/solana-smoke` (private, yayımlanmaz) ·
**Runbook:** [`docs/runbooks/upgrade.md`](../../docs/runbooks/upgrade.md)

Aynı komutlar her kümede çalışır; küme bir JSON yapılandırmasıyla seçilir:

| Komut | Ne yapar |
|---|---|
| `init` | Programları okur (executable, upgrade authority, executable hash). Eksik config'leri kurar: `init_registry_config`, `init_verifier_config`, `init_config`. Authority yapılandırmadaki yerel `admin` anahtarıysa talimatı gönderir. Değilse authority Squads vault'udur: talimat gönderilmez, Squads'a girilecek biçimde (program, hesaplar, base64 veri) yazılır ([runbook adım 5](../../docs/runbooks/upgrade.md#5-configlerin-kurulması-vault-imzasıyla)). Ardından Square ALT'ını açar ya da doğrular ([tx-budget.md §4](../../docs/design/tx-budget.md#4-square-alt)). En son config'leri zincirden okuyup kayıt satırlarını (Markdown) yazar. |
| `smoke` | 8 adım ve iki varyant gerçek işlemlerle (aşağıda). Her tx'in imzası, CU'su (`meta.computeUnitsConsumed`), CU sınırı, ücreti ve boyutu `docs/deploy/smoke-<küme>.md`'ye yazılır. |
| `smoke:localnet` | Geçici bir `solana-test-validator` açar, programları `target/deploy/*.so`'dan yükler, `init` ve `smoke`'u koşar, validator'ı kapatır. Rapor: [`docs/deploy/smoke-localnet.md`](../../docs/deploy/smoke-localnet.md). |

```bash
pnpm turbo run build --filter @squaresdk/solana-smoke...             # paket ve bağımlılıkları
pnpm --filter @squaresdk/solana-smoke run init --config <küme.json> [--records <kayıt.md>]
pnpm --filter @squaresdk/solana-smoke smoke --config <küme.json> [--report <rapor.md>]
pnpm --filter @squaresdk/solana-smoke smoke:localnet [--ledger <dizin>] [--rpc-port 8899] [--faucet-port 9900] \
  [--gossip-port 8001] [--dynamic-port-range 8100-8200] [--deploy-dir target/deploy] [--report <rapor.md>]
pnpm --filter @squaresdk/solana-smoke test                          # zincirsiz birim testleri
```

`init`, pnpm'in kendi `init` komutuyla çakıştığı için `run init` ile çağrılır.

`smoke` ve `smoke:localnet` ispatı süreç içinde üretir (`createLocalProver`, snarkjs). Devrenin wasm'ı
depoda değildir, önce derlenir: `circuits/payment-compliance/scripts/ci-build.sh` ya da
`cd circuits/payment-compliance && npm ci && CIRCOM=<circom 2.2.3> node scripts/build.mjs`. wasm ve zkey'in
SHA-256'sı devrenin `artifacts/manifest.json`'uyla karşılaştırılır.

## Smoke'un adımları

Numaralar [program arayüzü §3](../../docs/design/program-interface.md#3-sekiz-adımlı-akış--instruction-eşlemesi)'tekilerdir.
Her adımdan sonra sonuç zincirden okunup doğrulanır; tutmayan doğrulama koşuyu durdurur.

| Bölüm | Adım | Tx'ler | Zincirden doğrulanan |
|---|---|---|---|
| hazırlık | 0 | keeper'ın ATA'sı | — |
| 8 adım | 1 | `initInstitution` (yoksa) + `setPolicy` + `setBuyerRoot`, tek tx | commitment yerel politikayla aynı, tavan, alıcı kökü |
| | 2 | `registerAgent` | `AgentRecord` cüzdanı ve durumu |
| | 3 | `recordScreening` (kurum, agent, alıcı; screener authority), `createJob` (politikalı), eşikteyse `commitTravelRule`, `fundJob` | screening'ler temiz ve taze, vault tutarı |
| | 4 | `acceptJob`, `submitWork` | `Delivered`, iş hash'i |
| | 5 | `listClaim`, `buyClaim` (Merkle kanıtı) | listeleme `Bought`, agent fiyatı aldı |
| | 7 | in-process Groth16 ispatı, `setComplianceProof` | `ReleaseProof` uyumlu, payee alıcı, net tutar |
| | 6 + 8 | `finalizePayment` (keeper) | `Released`, alıcıya net, keeper'a ücret, `AgentReputation`, `ValidationRecord` `Verified`, listeleme `Settled`, ispat tüketildi |
| ispat-ret | 1–8 | işlem başı tavanı 1 olan ikinci politika; aynı akış, alacak satışı yok | ret kodu `PER_TX`, kesin ret; `Refunded`, net kuruma, keeper ücreti yine ödenir, `ValidationRecord` `Refused`, itibar değişmez |
| ispat-yok | 3–8 | ispatsız finalize (ön simülasyonsuz gönderilir) → `ProofRequired`; sonra ispat ve finalize | ret anında iş `Delivered`, vault dolu, `ReleaseProof` yok; ispat bağlanınca agent'a ödenir |
| fiat | 3–8 | Yalnızca `keys.mppAuthority` verilmişse ([`src/fiat.ts`](src/fiat.ts), ADR 0024): `createFiatJob`, `acceptJob` (açıkken), `submitWork`; `admin` yerel anahtarsa `updateMppAuthority` (yeni anahtar); Ed25519 attestation + `verifyMppPaymentProof`; `finalizeFiatPayment`; rotasyon yapıldıysa eski anahtara geri | ray `Fiat`, vault yok; `ReleaseProof` uyumlu, net işin tamamı, payee agent; `Released`, `ValidationRecord` `Verified`, itibar +1, günlük sayaç tutar kadar ilerledi, token hareketi yok; config'in MPP anahtarı upgrade'siz değişti |

- **Yeniden koşu:** Koşu kimliği agent kimliğine, spec'lere ve politika kimliklerine girer. Aynı anahtarlarla
  tekrar koşmak çakışmaz. Kurum hesabı varsa yeniden açılmaz. Üç iş fonlanır: kurumun token bakiyesi en az
  `3 × jobAmount`, alıcınınki en az `claimPrice` olmalıdır.
- **Saat** ([ADR 0012](../../docs/decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md)):
  - İspatın anı zincirin saatidir (Clock sysvar'ı; verifier ±600 s tolerans ister).
  - Finalize ispatla aynı UTC gününde olmalıdır: gün dönümüne challenge süresi + 180 s'den az kalmışsa ispat
    ertesi güne bırakılır.
  - Politikanın zaman penceresi haftanın her günü 00–23 UTC'dir: kural devrede denetlenir, smoke günün
    saatine bağlı kalmaz.
- **Gönderim:** Zincire girmeden blockhash'i dolan tx taze blockhash'le yeniden kurulur (en fazla 3 deneme).
  `init` yeni ALT'ı kesinleşene kadar bekler. İşlem zamanlayıcısı ALT'ı kök bankadan çözer; kök ALT'ı
  görmeden gönderilen v0 tx simülasyondan geçer ama zincire girmeden düşer.

## Küme yapılandırması

JSON, açılışta zod ile doğrulanır ([`src/config.ts`](src/config.ts)); varsayılan değer yoktur. Anahtar
**içerikleri** yapılandırmada ve depoda bulunmaz, yalnızca dosya yolları bulunur. Göreli yollar yapılandırma
dosyasının dizinine göre çözülür. Depo içindeki bir yol, dosya okunmadan reddedilir. RPC adresi API anahtarı
taşıyabilir. Bu yüzden `SMOKE_RPC_URL` ortam değişkeniyle de verilebilir; raporlara yalnızca sunucu adı
yazılır.

| Alan | Açıklama |
|---|---|
| `cluster` | Küme adı; rapor `docs/deploy/smoke-<cluster>.md`. `devnet`, `testnet`, `mainnet-beta` adlarında imzalar explorer'a bağlanır |
| `rpcUrl`, `commitment` | RPC ve `confirmed` / `finalized` |
| `programIds` | `registry`, `policy`, `verifier`, `escrow` (BC-09'da `set-program-ids.mjs`'in yazdığı kimlikler) |
| `settlementMint` | USDC mint'i; devnet: Circle devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| `lookupTable` | Square ALT'ı. Yoksa `init` açar ve adresini yazdırır; sonraki koşular için yapılandırmaya eklenir |
| `computeUnitPrice` | Öncelik ücreti (micro-lamport / CU); verilmezse eklenmez |
| `keys` | Anahtar dosyalarının yolları: `payer` (ücret ve rent), `admin` (yalnızca upgrade authority yerel bir anahtarsa), `lookupTableAuthority` (verilmezse payer), `screener`, `institution`, `agent`, `buyer`, `keeper`, `mppAuthority` (isteğe bağlı: `VerifierConfig.mpp_authority`'nin anahtarı; verilirse fiat varyantı koşar. Smoke Stripe ödemesi yapmaz, makbuz commitment'ı koşudan türetilir; gerçek Stripe akışı BE-25) |
| `init.registry` | `screenerAuthority` (screener servisinin anahtarı, BE-16), `screeningTtlSecs` |
| `init.verifier` | `mppAuthority` (BC-37) |
| `init.escrow` | `arbitrators` (2–7, tekrarsız) ve `threshold` (2 ≤ M ≤ N) (ADR 0016). `params`: challenge sınırları (0 < min ≤ max), `minBondBps`, `minBondAbsolute`, `keeperFeeBps` (≤ 100, ADR 0013), `proofTimeoutSecs` (≥ 0), `disputeTimeoutSecs` (> 0), `travelRuleThreshold` (0 = kapalı, ADR 0015). u64 değerler sayı ya da ondalık dize |
| `init.squads` | İsteğe bağlı `multisig`, `vaultIndex`. Verilirse zincirdeki upgrade authority bu vault'la karşılaştırılır |
| `smoke` | `jobAmount`, `claimPrice` (0 < fiyat < tutar), `challengePeriodSecs` (config sınırları içinde), `deadlineSecs` (> challenge), `paymentCategory` |

`init` yalnızca `payer`'ı (ve varsa `admin`'i) ister; `smoke` `payer`, `screener`, `institution`, `agent`,
`buyer` ve `keeper`'ı ister. `smoke:localnet` yapılandırmayı kendisi üretir
([`src/localnet.ts`](src/localnet.ts)): kısa challenge (`min_challenge_period` 1 s, iş 5 s), keeper ücreti
50 bps, 2-of-3 arbitrator, 6 ondalıklı yerel mint; MPP authority koşunun anahtarıdır, fiat varyantı koşar.

## Devnet: adım adım

Devnet'te programlar, Squads multisig'i, üç config ve Square ALT'ı kuruludur (BC-30); değerler
[`docs/deploy/devnet.md`](../../docs/deploy/devnet.md) ve `scripts/deploy/networks/devnet.json`'dadır. Smoke bu
kurulumu kullanır, yeniden kurmaz. Kayıt deploy'la oluşur: `docs/deploy/smoke-devnet.md` (BC-31).

1. **Program sürümü:** Devnet'teki escrow, kaydın gösterdiği commit'in derlemesidir. Smoke'un 8 adımı ve iki
   varyantı dispute talimatı kullanmaz; dispute'lu bir koşu için escrow'un Squads ile yükseltilmesi (runbook
   adım 6) beklenir.
2. **Anahtar dosyaları:** `payer`, `institution`, `agent`, `buyer` ve `keeper` için ayrı anahtarlar, depo dışında ve
   şifreli diskte tutulur.

   ```bash
   mkdir -p ~/square-devnet/keys && chmod 700 ~/square-devnet/keys
   for role in payer institution agent buyer keeper; do
     solana-keygen new --no-bip39-passphrase --silent -o ~/square-devnet/keys/$role.json
   done
   ```

   `screener` yeni üretilmez: registry config'indeki screener authority
   (`48DGxja6FefZHhZ8e5ynLKWLqxb1pVfiHFUVg1Jrm54b`) secret store'dadır ve screening kayıtlarını o imzalar. Smoke
   başka bir anahtarla açılmaz (`init.registry.screenerAuthority` zincirdekiyle karşılaştırılır). Authority'yi
   değiştirmek bir Squads işlemidir (`update_registry_config`, 2 / 3 onay).
3. **SOL:** `payer` en az 0,2 SOL, `keeper` en az 0,05 SOL ister.

   ```bash
   solana airdrop 2 $(solana-keygen pubkey ~/square-devnet/keys/payer.json) -u devnet
   solana airdrop 1 $(solana-keygen pubkey ~/square-devnet/keys/keeper.json) -u devnet
   ```

   RPC sınırına takılırsa <https://faucet.solana.com> kullanılır.
4. **Devnet USDC:** Circle'ın devnet mint'i `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Kurumun ve
   alıcının adresine <https://faucet.circle.com> ("Solana Devnet") ile gönderilir: kuruma en az
   `3 × jobAmount`, alıcıya en az `claimPrice`. Faucet ATA'yı açar.
5. **Yapılandırma:** `~/square-devnet/devnet.json`; yukarıdaki tablo ve devnet kaydının değerleri:
   `programIds`, `settlementMint`, `lookupTable: 3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG`,
   `init.squads.multisig: 3ucyX6nmbz9ytRVWr3wrYQD2try58Jy1xCyuNo8q6PD5`. `keys` yolları `keys/<rol>.json` biçiminde
   göreli verilebilir. `admin` verilmez: authority vault'tur. `init.escrow` değerleri `devnet.json`'dakilerdir;
   `proofTimeoutSecs` ve `disputeTimeoutSecs` sayı olarak yazılır.
6. **Init (yalnızca okur):**

   ```bash
   pnpm --filter @squaresdk/solana-smoke run init --config ~/square-devnet/devnet.json --records init-devnet.md
   ```

   Config'ler ve ALT zincirden okunup doğrulanır, kayıt satırları yazılır; kurulu config'e talimat üretilmez.
   Localnet dışında `init` ALT açmaz: `lookupTable` verilmezse durur, böylece devnet kaydındaki dondurulmuş ALT'ın
   yanında ikinci bir tablo oluşmaz.
7. **Smoke:**

   ```bash
   pnpm --filter @squaresdk/solana-smoke smoke --config ~/square-devnet/devnet.json   # docs/deploy/smoke-devnet.md
   ```

8. **CI:** [`.github/workflows/smoke.yml`](../../.github/workflows/smoke.yml), elle tetiklenir, küme girişte
   seçilir. Devnet işi `devnet` environment'ında koşar; environment'ın onay kuralı (required reviewers) işi
   kapıda tutar. Environment'ta şunlar tanımlıdır:
   - **Değişken:** `SMOKE_CONFIG`, yukarıdaki JSON; `keys` yolları `keys/<rol>.json`.
   - **Secret'lar:** `SMOKE_PAYER_KEYPAIR`, `SMOKE_SCREENER_KEYPAIR`, `SMOKE_INSTITUTION_KEYPAIR`,
     `SMOKE_AGENT_KEYPAIR`, `SMOKE_BUYER_KEYPAIR`, `SMOKE_KEEPER_KEYPAIR` (anahtar dosyalarının içeriği) ve
     isteğe bağlı `SMOKE_RPC_URL`.

   Anahtarlar iş süresince runner'ın geçici dizinine yazılır ve iş sonunda silinir. Rapor iş özetine ve
   artefakta yazılır; depoya elle commit'lenir.

## Dosyalar

| Dosya | İçerik |
|---|---|
| [`src/config.ts`](src/config.ts) | Yapılandırma şeması, ADR 0013 / 0016 kuralları |
| [`src/keys.ts`](src/keys.ts) | Anahtar dosyaları; depo içi yol reddi |
| [`src/chain.ts`](src/chain.ts) | Gönderici (yeniden kurma, beklenen ret), tx kaydı, Clock sysvar'ı, upgradeable loader hesapları, executable hash'i, Squads vault türetmesi |
| [`src/init.ts`](src/init.ts) | Config'ler, Squads talimatları, Square ALT'ı, kayıt |
| [`src/smoke.ts`](src/smoke.ts) | 8 adım ve varyantlar |
| [`src/prover.ts`](src/prover.ts) | Devre artefaktları ve in-process prover |
| [`src/render.ts`](src/render.ts) | Markdown: Squads talimatları, init kaydı, smoke raporu |
| [`src/cli.ts`](src/cli.ts), [`src/localnet.ts`](src/localnet.ts) | Komutlar ve localnet koşucusu |

Birim testleri zincirsizdir. Zincirle çalışan akışlar (`runSmoke`, localnet koşucusunun süreç yönetimi,
prover) `smoke:localnet` koşusunda gerçek işlemlerle sınanır ve kapsam ölçümünün dışındadır.

Modüller `@squaresdk/solana-smoke/<modül>` olarak dışa açıktır. Servis entegrasyon testi
([`tests/services`](../services/), BE-36) localnet koşucusunun parçalarını (`startValidator`, `fundLocalnet`,
`assertDeployedPrograms`), `runInit`'i ve `runSmoke`'u kullanır. `runSmoke`'un isteğe bağlı üç kancası vardır;
verilmezse smoke tx'leri kendisi gönderir:
- `screen(wallet)`: adım 3'ün screening kaydını yazar (servis testinde screener servisi).
- `finalize(job, expectError)`: challenge bittikten sonra finalize'ı yapar ya da beklenen bekletmeyi bekler (servis
  testinde keeper servisi).
- `provers`: bölüme özel prover (servis testinde ispat-yok ispatı API ve prover servisinden).

Keeper finalize'ı ispat bağlandığı anda yapabileceği için bakiye ve itibar karşılaştırmalarının "önce" değerleri
ispattan önce okunur.

## Devnet koşusu

[`docs/deploy/smoke-devnet.md`](../../docs/deploy/smoke-devnet.md): 2026-10-06, 8 adım ve iki varyant, 28 tx. Roller
devnet kaydındaki anahtarlardır: payer deployer, kurum ve agent BC-36'nınkiler; alıcı ve keeper koşu için üretildi.
