# Runbook: program kimlikleri, Squads upgrade authority ve upgrade

**Issue:** BC-09 (#9), BC-30 (#38) · **Kararlar:** [ADR 0004](../decisions/0004-gecmisli-tasima-ve-yeni-program-idleri.md)
(yeni program kimlikleri), [ADR 0008](../decisions/0008-upgrade-authority-2-of-3-squads.md) (2-of-3 Squads)

Dört Square programının (`square_policy`, `square_verifier`, `square_registry`, `square_escrow`) kimliklerinin
üretilmesi, depoya uygulanması, upgrade authority'nin 2-of-3 Squads v4 multisig'e devri ve sonraki upgrade'ler.
Adımlar sırayla uygulanır. Her adımın çıktısı (adresler, imzalar, hash'ler) ilgili ağın deploy kaydına yazılır
(`docs/deploy/<ağ>.md`, BC-30). Kayıt dosyası ilk deploy'la birlikte oluşturulur.

## Kurallar

- **Anahtarlar repoya girmez.** Program keypair'leri ve deployer anahtarı ekibin secret store'unda tutulur;
  dosya olarak yalnızca işlem süresince, şifreli diskte ve repo dışında bulunur. `.gitignore` `*keypair*.json`'u
  dışlar; pre-commit kancası (gitleaks, `.gitleaks.toml`) keypair dosyasını ve 64 baytlık gizli anahtar dizisini
  yakalar.
- **Program keypair'i** yalnızca programın ilk deploy'unda gerekir (program adresini o belirler). Sonraki
  upgrade'ler upgrade authority'yle, yani Squads vault'uyla yapılır.
- **Upgrade authority** bir kişinin anahtarı olarak kalmaz: ilk deploy'dan hemen sonra vault'a devredilir.
- **Config'ler vault'la kurulur.** `init_*` config talimatları yükseltme yetkilisini `program_data`'dan
  doğrular ve imzalayanı `admin` olarak yazar. Program arayüzünde admin devri talimatı yoktur. Bu yüzden
  config'ler authority devrinden **sonra**, vault imzasıyla (Squads işlemi) kurulur; deployer anahtarı hiçbir
  config'in admin'i olmaz.

## 1. Program keypair'lerinin üretilmesi

Ağ başına bir kez, çevrimdışı ya da ağdan yalıtılmış bir makinede yapılır.

```bash
# Vanity zorunlu değil (ADR 0008, açık nokta). İstenirse örnek önek:
solana-keygen grind --starts-with Sq:1 --ignore-case          # her program için ayrı
# Vanity'siz:
solana-keygen new --no-bip39-passphrase --silent -o square_escrow-keypair.json
solana-keygen pubkey square_escrow-keypair.json
```

Dört keypair secret store'a `square/<ağ>/program/<program>` adıyla yüklenir, yerel kopyalar silinir. Açık
anahtarlar (program kimlikleri) gizli değildir; deploy kaydına ve depoya yazılır.

## 2. Kimliklerin depoya uygulanması

```bash
node scripts/deploy/set-program-ids.mjs \
  --policy <id> --verifier <id> --registry <id> --escrow <id>
```

Betik değiştirdiği yerler:

- `declare_id!`;
- `Anchor.toml`'un `[programs.localnet]` ve `[programs.devnet]` bölümleri;
- sözleşme IDL'lerinin `address` alanları ve `init_*` talimatlarının `program` hesapları.

İş bitince eski kimliklerin kaldığı dosyaları listeler. Kaynak projelerin tarihsel kayıtları ve AIP v1 çözümü
listelenmez. Ardından:

```bash
pnpm --filter @squaresdk/solana-types gen && pnpm --filter @squaresdk/solana-sdk gen   # türetilen IDL'ler
mkdir -p target/deploy && anchor build
node scripts/ci/idl-conformance.mjs
(cd circuits/payment-compliance && node scripts/program-proofs.mjs && node scripts/program-proofs.mjs --check)
cargo test --locked --manifest-path tests/programs/Cargo.toml   # job PDA'ları ve ispatlar yeni kimliklerle
pnpm turbo run build typecheck test
```

İspat fikstürleri yeniden üretilir: job adresleri escrow kimliğinden türediği için ispatların sinyalleri değişir.
Betiğin listelediği test fikstürleri (ör. `packages/types/test/*`) aynı PR'da güncellenir. Değişiklik tek
PR'dır; birleşmeden önce program kontrollerinin tamamı yeşil olmalıdır ([docs/ci.md](../ci.md)).

## 3. Squads v4 multisig

[Squads](https://app.squads.so) arayüzünden ya da `scripts/deploy/squads-multisig.mjs` ile (Squads v4 SDK), ağ başına bir
multisig kurulur:

```bash
node scripts/deploy/squads-multisig.mjs create --rpc <url> --creator <ücreti ödeyen keypair> \
  --member <adres> --member <adres> --member <adres> --threshold 2 --time-lock 0
node scripts/deploy/squads-multisig.mjs show --rpc <url> --multisig <adres>   # doğrulama, JSON
```

| Ayar | Değer |
|---|---|
| Üyeler | MuhammedAkinci, mehmethayirli, kh0ra (her biri kendi donanım cüzdanı ya da kişisel anahtarı) |
| Eşik | 2 |
| İzinler | üç üye de Initiate + Vote + Execute |
| Time lock | devnet 0; mainnet kararı BC-42'de |

Kurulumdan sonra doğrulanır ve deploy kaydına yazılır:

- **Multisig ve vault:** multisig adresi ve vault PDA'sı (indeks 0; `square_common::squads::vault_address`,
  SDK'da aynı türetme);
- **Ayarlar:** üye anahtarları ve eşik. Squads arayüzü ya da `getAccountInfo` ile multisig hesabı okunur.

Vault, ücret ve rent ödeyebilmesi için SOL'le fonlanır.

## 4. İlk deploy ve authority devri

Deployer anahtarı yalnızca bu adım için kullanılır ve ücret / buffer rent'ini öder.

```bash
solana config set --url <rpc>
solana-verify build --base-image <verifiable-build.yml'deki BASE_IMAGE> --library-name square_escrow   # her program
solana program deploy target/deploy/square_escrow.so \
  --program-id <secret store'dan program keypair'i> \
  --upgrade-authority <deployer>
solana program set-upgrade-authority <program id> \
  --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check
solana program show <program id>        # Authority: <vault>, Executable
solana-verify get-program-hash -u <rpc> <program id>   # build'in hash'iyle aynı
```

Genel devnet RPC'si yoğun yazmada hız sınırına (429) takılır. `--use-rpc` verilmez: CLI buffer'ı doğrudan
validator'lara (TPU) yazar, RPC'yi yalnızca onay için kullanır. Yarıda kalan deploy'un buffer'ı
`solana program close --buffers` ile kapatılıp rent'i geri alınır. `--max-len` program boyutundan büyük
verilirse yükseltmelere yer kalır (devnet: 1,5 katı).

Verifiable build (BC-13) ile derlenmiş `.so` kullanılır. Böylece zincirdeki hash, depodaki commit'ten herkesin
yeniden üretebileceği hash olur. Dört programın kimliği, deploy imzası, executable hash'i ve authority'si
deploy kaydına yazılır.

## 5. Config'lerin kurulması (vault imzasıyla)

Her `init_*` talimatı bir Squads vault işlemidir. Squads arayüzünde "Transaction builder" ya da SDK'yla
`vault_transaction_create` → iki onay → `vault_transaction_execute`. Talimatların imzacısı (`admin`) ve
ödeyicisi vault'tur. Talimatlar ve argümanlar
([program arayüzü §10](../design/program-interface.md#10-referans-tabloları)):

| Program | Talimat | Ağ başına değerler |
|---|---|---|
| `square_registry` | `init_registry_config(screener_authority, screening_ttl_secs)` | screener servisinin authority'si (BE-16), screening ömrü |
| `square_verifier` | `init_verifier_config(escrow_program, policy_program, mpp_authority)` | escrow ve policy kimlikleri, MPP authority (BC-37) |
| `square_escrow` | `init_config(settlement_mint, arbitrators, threshold, params, linked)` | USDC mint'i (devnet: Circle devnet USDC), arbitrator seti ve eşiği (program arayüzü §6), `EscrowParams` (challenge sınırları, bond, keeper ücreti ≤ 100 bps, `proof_timeout_secs ≥ 0`, `dispute_timeout_secs > 0`, Travel Rule eşiği), bağlı program kimlikleri |

Değerler `scripts/deploy/networks/<ağ>.json`'dadır (anahtar değil, açık değerler; `network-config.mjs`
programların kurallarıyla doğrular). Betik her config için vault işlemini ve önerisini açar, iki üyeyle
onaylar ve yürütür. Kurulmuş config atlanır; yarıda kalan öneri kaldığı adımdan sürdürülür:

```bash
node scripts/deploy/init-configs.mjs --network <ağ> --member <üye keypair> --member <üye keypair>
node scripts/deploy/init-configs.mjs --network <ağ> --show       # zincirdeki config'ler, JSON
node scripts/deploy/create-lookup-table.mjs --network <ağ> --payer <keypair>   # Square ALT, kurulup dondurulur
```

Talimat verileri SDK'nın builder'larıyla üretilir. [`tests/smoke`](../../tests/smoke/)'un `init` komutu
bunu yapar: upgrade authority vault'sa talimatları göndermez, Squads'a girilecek biçimde (program, hesaplar ve
imza / yazma bayrakları, base64 veri, okunur argümanlar) yazar. Squads'a girilecek talimatlar ve değerler PR'da
ya da deploy kaydında, iki üyenin onayından önce yazılı olur. Kurulumdan sonra `init` yeniden koşulur: config
hesapları okunur ve değerler kayıt satırları olarak yazılır. Square ALT'ı (BC-28,
[tx-budget.md](../design/tx-budget.md)) aynı komutla bu adımdan sonra kurulur. Ardından uçtan uca smoke koşulur
(BC-31, `smoke` komutu); rapor `docs/deploy/smoke-<ağ>.md`.

```bash
pnpm --filter @squaresdk/solana-smoke run init --config <ağ.json> --records <kayıt.md>
pnpm --filter @squaresdk/solana-smoke smoke --config <ağ.json>
```

## 6. Upgrade

```bash
solana-verify build --base-image <BASE_IMAGE> --library-name <program>
solana program write-buffer target/deploy/<program>.so            # buffer adresi
solana program set-buffer-authority <buffer> --new-buffer-authority <vault>
```

Ardından Squads'ta "Upgrade program" işlemi açılır (program, buffer, spill hesabı). İki üye onaylar, işlem
yürütülür. Betikle:

```bash
node scripts/deploy/upgrade-program.mjs --network <ağ> --program <program> --buffer <buffer> \
  --spill <adres> --member <keypair> --member <keypair>
```

Betik buffer'ın ve programın authority'sinin vault olduğunu denetler, loader'ın `Upgrade` talimatını vault işlemi
olarak açar, iki üyeyle onaylar ve yürütür (yarıda kalan işlemi sürdürür). Sonra:

```bash
solana program show <program id>                                  # Last Deployed In Slot güncel
solana-verify get-program-hash -u <rpc> <program id>              # yeni build'in hash'i
```

Kontrol listesi:

- **Sözleşme:** Sözleşme değiştiyse (`idl/`, [program arayüzü §11](../design/program-interface.md#11-sözleşme-değişiklik-kaydı))
  IDL ve türetilen dosyalar aynı commit'tedir; istemciler (web, SDK sürümü) upgrade'le birlikte yayımlanır.
- **Hesap düzeni:** Hesap düzeni değişen bir upgrade, mevcut hesaplar için geçiş planı olmadan yapılmaz.
  1.0.0'a kadar düzen değişikliği MINOR sürümdür.
- **Doğrulama anahtarı:** `square_verifier`'ın `RELEASE_VK_VERSION`'ı arttıysa (yeni doğrulama anahtarı, BC-38),
  upgrade yürütülüp onaylandıktan sonra ikinci bir vault işlemiyle `sync_vk_version` çağrılır. Config sonra
  okunur: `vk_version` programın sürümünü göstermelidir. Talimat config programla aynı sürümdeyse
  `VkVersionAlreadySynced` ile düşer; bu, upgrade'in yürütülmediğini ya da eski kodun çalıştığını gösterir.
- **Kayıt:** Deploy kaydına sürüm, commit, hash, Squads işlem adresi ve imzalar yazılır.

## 7. Olağan dışı durumlar

| Durum | Yapılacak |
|---|---|
| Bir üyenin anahtarı kayboldu | Kalan iki üye Squads'ta üye değişikliği (config transaction) yapar; eşik 2 korunur |
| Bir üyenin anahtarı ele geçirildi | Aynı gün üye değiştirilir; bekleyen işlemler iptal edilir |
| Buffer yanlış yüklendi | `solana program close <buffer>` (buffer authority vault ise Squads işlemiyle) |
| Program keypair'i sızdı | Deploy edilmiş program için etkisi yoktur (upgrade authority vault'tadır); henüz deploy edilmemişse kimlik yeniden üretilir (adım 1–2) |
