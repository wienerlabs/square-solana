# Komut satırı: `squaresdk-solana`

**Paket:** [`@squaresdk/solana-cli`](../packages/cli/) · **Issue:** BE-30 (#89) · **Karar:** [ADR 0025](decisions/0025-cli-komut-adi-ve-yapilandirma.md)

> Bu belge `packages/cli/scripts/reference.mjs` ile komut tablosundan üretilir; elle değiştirilmez.

`squaresdk-solana <grup> <eylem> [seçenekler]`. Akışın 8 adımı, uyuşmazlık ve did:aip çözümü. Her komut bir tx kurar
(SDK akışı ya da program talimatı), rol anahtarıyla imzalar, gönderir ve onayını bekler. Sonuç standart çıktıya,
ilerleme ve hatalar standart hataya yazılır.

## Yapılandırma

Öncelik sırası: bayrak, ortam değişkeni, yapılandırma dosyası, varsayılan. Dosya `--config`, `SQUARESDK_SOLANA_CONFIG` ya da
varsa `~/.config/squaresdk-solana/config.json`. Dosyada sır yoktur: anahtarlar `solana-keygen` biçimindeki dosyaların
yollarıdır, prover'ın API anahtarı yalnızca `SQUARESDK_SOLANA_PROVER_API_KEY` ortam değişkenindedir.

```json
{
  "cluster": "devnet",
  "rpcUrl": "https://api.devnet.solana.com",
  "commitment": "confirmed",
  "keypair": "~/.config/solana/id.json",
  "feePayer": "<ücret ödeyen keypair yolu>",
  "computeUnitPrice": 1000,
  "lookupTable": "<Square ALT adresi>",
  "prover": {
    "url": "<Square API ya da prover servisi>",
    "artifactVersion": "<zkey SHA-256>"
  }
}
```

| Ortam değişkeni | Karşılığı |
|---|---|
| `SQUARESDK_SOLANA_CONFIG` | `--config` |
| `SQUARESDK_SOLANA_CLUSTER` | `--cluster` |
| `SQUARESDK_SOLANA_RPC_URL` | `--rpc-url` |
| `SQUARESDK_SOLANA_KEYPAIR` | `--keypair` |
| `SQUARESDK_SOLANA_FEE_PAYER` | `--fee-payer` |
| `SQUARESDK_SOLANA_PROVER_URL` | `--prover-url` |
| `SQUARESDK_SOLANA_PROVER_API_KEY` | prover'ın API anahtarı (yalnızca ortamdan) |

## Global seçenekler

| Seçenek | Açıklama |
|---|---|
| `--config <yol>` | yapılandırma dosyası (varsayılan ~/.config/squaresdk-solana/config.json) |
| `--cluster <küme>` | localnet \| devnet \| mainnet-beta (varsayılan devnet) |
| `--rpc-url <url>` | RPC adresi (varsayılan kümenin herkese açık RPC'si) |
| `--keypair <yol>` | rol imzacısı (varsayılan ~/.config/solana/id.json) |
| `--fee-payer <yol>` | ücret ve rent ödeyen (varsayılan imzacı) |
| `--compute-unit-price <n>` | öncelik ücreti, micro-lamport / CU |
| `--lookup-table <adres>` | Square address lookup table'ı |
| `--prover-url <url>` | ispat için Square API ya da prover servisi |
| `--artifact-version <hex>` | prover'ın zkey SHA-256'sı |
| `--json` | sonucu tek JSON nesnesi olarak yazar |

## Çıktı ve çıkış kodları

- `--json`: sonuç tek satırlık bir JSON nesnesi; adresler base58, tutarlar ondalık dize, hash'ler hex.
- Hata: standart hataya `hata: <mesaj>`; `--json` ile standart çıktıya `{"error": "<mesaj>"}`. Program hatası
  `<program> programı hatası <kod> <ad>` biçimindedir.
- Çıkış kodu: 0 başarı, 1 hata, 2 kullanım hatası (bilinmeyen komut ya da seçenek).

## İspat

`proof bind` ve `policy watch` ispatı uzak prover'dan alır: Square API (`/v1/prove`, `prove` kapsamlı API
anahtarı) ya da prover servisi (`apps/prover`). `artifactVersion` zincirdeki doğrulama anahtarının zkey'idir;
prover başka bir anahtarla çalışıyorsa istek reddedilir. CLI ispatı yerelde üretmez (ADR 0025).

## Komutlar

### agent

#### `squaresdk-solana agent register`

Adım 2: agent kaydı (imzacı kaydın sahibi).

| Seçenek | Açıklama |
|---|---|
| `--id <agent_id>` | 1–32 karakter, [A-Za-z0-9_-] |
| `--card-uri <uri>` | agent card adresi; verilmezse kart yok |
| `--card-file <yol>` | kartın baytları; hash SHA-256 (did:aip v2 §4.2) |
| `--wallet <adres>` | ödemeleri alan cüzdan; verilmezse imzacı |

#### `squaresdk-solana agent resolve <did>`

Did:aip çözümü: DID belgesi ve kartın hash doğrulaması (BE-09).

| Seçenek | Açıklama |
|---|---|
| `<did>` | did:aip:solana:<zincir>:<registry>:<kayıt> |

### screening

#### `squaresdk-solana screening record`

Adım 3: sanctions screening kaydı (imzacı registry config'indeki screener authority).

| Seçenek | Açıklama |
|---|---|
| `--wallet <adres>` | taranan cüzdan |
| `--status` | <clear\|flagged> |
| `--source-hash <hex>` | kanıt belgesinin SHA-256'sı (ADR 0020) |

### policy

#### `squaresdk-solana policy secret`

Adım 1: politika sırrı (salt'lar bundan türer; kurumda kalır).

| Seçenek | Açıklama |
|---|---|
| `--out <yol>` | sırrın yazılacağı dosya (0600, üstüne yazılmaz) |

#### `squaresdk-solana policy commit`

Adım 1: kurum (yoksa) ve politikanın commitment'ı + public tavanı (imzacı kurumun yetkilisi).

| Seçenek | Açıklama |
|---|---|
| `--policy <yol>` | politika belgesi (JSON, @squaresdk/solana-types PolicyDocument) |
| `--secret <yol>` | politika sırrı |
| `--name <ad>` | kurumun adı; kurum henüz yoksa gerekli (en fazla 64 bayt) |

#### `squaresdk-solana policy buyers`

Adım 5: onaylı alıcı listesinin kökü; liste ve salt'lar dosyaya yazılır (alıcılara kanıt için).

| Seçenek | Açıklama |
|---|---|
| `--policy <yol>` | politika belgesi |
| `--secret <yol>` | politika sırrı |
| `--buyer <adres>` | onaylı alıcı (birden çok kez) |
| `--out <yol>` | liste dosyası: alıcılar, salt'ları ve kök (0600, üstüne yazılmaz) |

#### `squaresdk-solana policy watch`

Adım 7: job'un ispatını izler; yoksa ya da bayatlayınca yeniden üretip bağlar (Ctrl-C ile durur).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | politikaya bağlı, teslim edilmiş job |
| `--policy <yol>` | politika belgesi |
| `--secret <yol>` | politika sırrı |
| `--category <ad>` | ödeme kategorisi (politikanın izin verdiği) |
| `--interval <ms>` | kontrol aralığı (varsayılan 15000) |

### job

#### `squaresdk-solana job create`

Adım 3: job açılışı ve boş vault (imzacı kurum cüzdanı).

| Seçenek | Açıklama |
|---|---|
| `--agent-record <adres>` | registry AgentRecord |
| `--spec <yol>` | iş tanımı (JSON; hash RFC 8785 + SHA-256) |
| `--amount <taban birim>` | escrow tutarı (settlement mint) |
| `--deadline <zaman>` | teslim son tarihi: unix saniyesi ya da +<saniye> |
| `--challenge-period <s>` | teslimden sonraki itiraz penceresi (saniye) |
| `--policy <adres>` | isteğe bağlı: ispat kapılı iş için politika |

#### `squaresdk-solana job fund`

Adım 3: tutarı kurumun token hesabından vault'a kilitler (imzacı kurum).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job hesabı |

#### `squaresdk-solana job accept`

Adım 4: işi kabul eder (imzacı job'un agent cüzdanı).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job hesabı |

#### `squaresdk-solana job submit`

Adım 4: teslim; challenge penceresi açılır (imzacı agent cüzdanı).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job hesabı |
| `--work <yol>` | teslim edilen içerik; iş hash'i SHA-256 |
| `--delivery-uri <uri>` | teslimin adresi (en fazla 128 bayt) |

#### `squaresdk-solana job finalize`

Adım 6 + 8: challenge'dan sonra permissionless kapanış; keeper ücreti imzacıya.

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job hesabı |

#### `squaresdk-solana job cancel`

Açık ya da fonlanmış işi (kabul edilmişse son tarihten sonra) iptal eder; tutar kuruma döner.

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job hesabı |

#### `squaresdk-solana job show`

Job hesabı (IDL JSON).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job hesabı |

### claim

#### `squaresdk-solana claim list`

Adım 5: alacağı yüz değerin altında listeler (imzacı job'un agent cüzdanı).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | teslim edilmiş job |
| `--price <taban birim>` | 0 < fiyat < tutar |

#### `squaresdk-solana claim buy`

Adım 5: alacağı satın alır; payee alıcı olur (imzacı alıcı).

| Seçenek | Açıklama |
|---|---|
| `--job` | <adres> |
| `--price <taban birim>` | listeleme fiyatı (önden koşmaya karşı aynı olmalı) |
| `--buyers <yol>` | policy buyers dosyası; politikasız ya da kısıtsız işte verilmez |

#### `squaresdk-solana claim cancel`

Satılmamış listelemeyi geri çeker (imzacı satıcı).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | listelenmiş job |

### proof

#### `squaresdk-solana proof bind`

Adım 7: ispatı üretir (uzak prover) ve job'a bağlar (imzacı kurumun yetkilisi).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | politikaya bağlı, teslim edilmiş job |
| `--policy <yol>` | politika belgesi |
| `--secret <yol>` | politika sırrı |
| `--category <ad>` | ödeme kategorisi (politikanın izin verdiği) |

#### `squaresdk-solana proof preflight`

Kabul öncesi ön-ispatı üretir (uzak prover) ve job'a bağlar; policy'li işte agent bundan sonra kabul eder (ADR 0028).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | politikaya bağlı, açık ya da fonlanmış job |
| `--policy <yol>` | politika belgesi |
| `--secret <yol>` | politika sırrı |
| `--category <ad>` | ödeme kategorisi (politikanın izin verdiği) |

### dispute

#### `squaresdk-solana dispute raise`

Challenge penceresinde teslime itiraz; bond kurumun token hesabından kilitlenir (imzacı kurum).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job |
| `--evidence <yol>` | kanıt dosyası; reasonHash SHA-256 (ya da --reason-hash <hex>) |
| `--bond <taban birim>` | verilmezse en düşük bond: max(tutar × min_bond_bps / 10 000, min_bond_absolute) |

#### `squaresdk-solana dispute vote`

Arbitrator oyu; eşik dolunca karar kesinleşir (imzacı arbitrator).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | job |
| `--resolution <karar>` | favor-agent \| favor-institution \| split |
| `--agent-amount <birim>` | split: agent tarafına ödenecek tutar |

#### `squaresdk-solana dispute execute`

Kesinleşmiş kararı öder; permissionless.

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | dispute açık job |

#### `squaresdk-solana dispute lapse`

Son tarihi geçmiş, karara bağlanmamış dispute'u düşürür; bond kuruma döner (permissionless).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | dispute açık job |

#### `squaresdk-solana dispute escalate`

Policy'li işte ispat bağlanmadıysa agent'ın bond'suz dispute başvurusu (imzacı agent cüzdanı).

| Seçenek | Açıklama |
|---|---|
| `--job <adres>` | dispute açık job |

## Örnek: 8 adım

Devnet kabul koşusunun komutları ve imzaları: [deploy/cli-devnet.md](deploy/cli-devnet.md).
