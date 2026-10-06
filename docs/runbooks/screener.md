# Runbook: screener

**Issue:** BE-31 (#90). Sanctions screening'in zincirdeki kaydı (`square_registry` `record_screening`). Escrow kaydı
şu adımlarda okur:
- `fund_job`: kurum ve agent cüzdanı.
- `buy_claim`: alıcı.
- `finalize_payment` ve `execute_resolution`: payee.

Kayıt `Clear` ve süresi dolmamış (`expires_at > now`) olmalı. Değilse fonlama ve alım reddedilir; ödeme bekler,
iade edilmez.

> Otomatik tarama ve TTL yenileme screener servisindedir ([`apps/screener`](../../apps/screener/README.md)). Servis
> dağıtılana kadar ve onun yedeği olarak tarama bu runbook'la, `scripts/deploy/record-screening.mjs` ile yapılır.

## Roller ve anahtar

- **Screener authority:** `RegistryConfig.screener_authority`. `record_screening`'i yalnızca bu anahtar imzalar.
  Anahtar secret store'dadır; dosya olarak yalnızca işlem süresince ve repo dışında bulunur.
- **Kaydın süresi:** `RegistryConfig.screening_ttl_secs`. Devnet'te 30 gün
  ([deploy kaydı](../deploy/devnet.md#configler-vault-imzasıyla)).
- **Config'in admin'i:** Squads vault'u. Authority ve süre yalnızca vault işlemiyle değişir
  (`update_registry_config`).

## Tarama

Kaynak OFAC'ın SDN listesidir. Listedeki dijital para adresleri cüzdanlarla tam eşleşmeyle karşılaştırılır. Kaydın
`source_hash`'i listenin SHA-256'sıdır; hangi yayına karşı tarandığı zincirde kalır.

```bash
# Önce kuru koşu: sonuç yazılmaz, listenin yayın tarihi ve hash'i görünür.
node scripts/deploy/record-screening.mjs --network devnet --wallet <adres> --wallet <adres> --dry-run
# Kayıt: listede olmayan Clear, olan Flagged.
node scripts/deploy/record-screening.mjs --network devnet --screener <keypair> --payer <keypair> \
  --wallet <adres> --wallet <adres>
```

Çıktı yayın tarihini, kayıt sayısını, hash'i, sonuçları ve imzaları içerir. Kayıt istenirse deploy kaydına
yazılır. Betik, verilen anahtarın config'teki screener authority olduğunu yazmadan önce denetler.

## Ne zaman taranır

| Durum | Kim | Ne |
|---|---|---|
| Kurum ilk job'unu fonlayacak | Kurum adına operasyon | Kurum ve job'un agent cüzdanı |
| Agent kaydoldu ya da cüzdanını değiştirdi | Operasyon | Agent cüzdanı |
| Alıcı alacak alacak | Operasyon | Alıcı cüzdanı |
| Kayıt dolmak üzere | Operasyon | Süresi `screening_ttl_secs`'in son haftasına giren kayıtlar, ödeme bekleyen job'ların payee'leri önce |
| Keeper `screeningPending` bekletiyor | Operasyon | `GET /v1/keeper/actions?outcome=skipped`'teki job'un payee'si (alacak satılmışsa alıcı) |
| SDN listesi güncellendi | Operasyon | Etkin cüzdanlar yeniden taranır; yeni `Flagged` kayıt fonlamayı, alımı ve ödemeyi durdurur |

Bir cüzdanın kaydı `GET /v1/screening/{wallet}` ile görülür.

## `Flagged` kayıt

- Listede adı geçen cüzdanın işi durur: fonlama ve alım reddedilir, ödeme bekler.
- Uyum ekibine bildirilir; karar ekibindir.
- Yanlış eşleşme şüphesinde liste yeniden indirilip tarama tekrarlanır. Kayıt her taramada üzerine yazılır
  (`init_if_needed`).

## Anahtar rotasyonu

1. Yeni anahtar üretilir ve secret store'a konur.
2. Squads'ta `update_registry_config(screener_authority = yeni, screening_ttl_secs = mevcut)` önerilir, eşik onaylar,
   yürütülür ([upgrade runbook'undaki vault işlemleri](upgrade.md)).
3. `RegistryConfig` yeni authority'yi gösterince eski anahtar silinir. Eski anahtarla yazılmış kayıtlar süreleri
   dolana kadar geçerlidir.
