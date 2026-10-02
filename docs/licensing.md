# Lisans politikası

Karar: [§12.5](analysis/square-solana-analysis.md#125-lisans). Bu belge kararın repoda nasıl
uygulandığını ve CI'ın neyi denetlediğini tanımlar.

## Proje lisansı

- Repo **Apache-2.0** altındadır: [`LICENSE`](../LICENSE).
- Square'in kurulduğu üç proje (Aperture, AIP, Covenant) ekibin kendi projeleridir; hakları ekibe
  aittir. Kökenleri ve orijinal lisansları [`NOTICE`](../NOTICE)'te kayıtlıdır.

## Taşınan kod

Bir kaynak projeden dizin taşıyan PR, aynı PR'da:

1. kaynağın `LICENSE` dosyasını taşınan dizinde korur (ör. `programs/square-policy/LICENSE`);
2. kaynak repo, commit ve yöntemi [`provenance/`](provenance/) altında issue başına bir dosyaya
   yazar (ör. [`provenance/BC-05.md`](provenance/BC-05.md));
3. taşınan yolu `NOTICE`'teki ilgili bölüme ekler.

Dosyalara tek tek başlık eklenmez, birinci taraf kod CI'da denetlenmez.

## Yeni dosyalar

Bu repoda yazılan kaynak dosyalar ilk satırda (shebang varsa ondan sonra) SPDX başlığı taşıyabilir;
zorunlu değildir:

```rust
// SPDX-License-Identifier: Apache-2.0
```

## Üçüncü taraf bağımlılıklar

Envanter: [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md). Kaynak:
[`scripts/license/`](../scripts/license/) (Covenant `license-inventory.ts` uyarlaması).

| Durum | Anlamı | CI |
|---|---|---|
| ✓ ok | SPDX ifadesi izin verici (`policy.mjs` → `PERMISSIVE`), ya da elle değerlendirilip `cleared` | geçer |
| ⚠️ inceleme | izin verici değil, `ASSESSED`'te `review` olarak kayıtlı, hukuki onay bekliyor | uyarır |
| ❌ izinsiz / bilinmiyor | lisans alanı yok, ayrıştırılamıyor ya da copyleft ve değerlendirilmemiş | kırar (runtime) |

- Kapsam **doğrudan** bağımlılıklardır: her workspace paketinin `package.json`'ı ve her crate'in
  `Cargo.toml`'u. Kapıyı yalnızca **runtime** bağımlılıklar kırar; dev ve build bağımlılıkları
  dağıtılan artefakta girmediği için raporlanır ama kırmaz.
- SPDX ifadeleri AND / OR / WITH ve parantezle ayrıştırılır: `MIT OR GPL-3.0-only` izinli,
  `MIT AND GPL-3.0-only` değil. Cargo'nun eski `MIT/Apache-2.0` yazımı OR sayılır.
- İzin verici olmayan bir bağımlılık bilinçli olarak eklenecekse `ASSESSED`'e gerekçesiyle
  (`"npm:<ad>"` ya da `"cargo:<ad>"`) kaydedilir.

## Komutlar

```bash
pnpm install
pnpm license:check
pnpm license:write
node --test "scripts/**/*.test.mjs"
```

`license:check` runtime bağımlılık lisanslarını ve `THIRD_PARTY_LICENSES.md`'deki tablonun
güncelliğini denetler. Bağımlılık eklendiğinde ya da kaldırıldığında `license:write` çalıştırılıp
tablo commit'lenir. CI: [`.github/workflows/license.yml`](../.github/workflows/license.yml).
