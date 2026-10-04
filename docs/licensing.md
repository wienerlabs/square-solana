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
3. taşınan yolu `NOTICE`'teki ilgili bölüme ekler;
4. paketlerdeki `NOTICE` kopyalarını `pnpm license:write` ile günceller
   ([Dağıtılan paketler](#dağıtılan-paketler)).

Dosyalara tek tek başlık eklenmez, birinci taraf kod CI'da denetlenmez.

Covenant'ın LGPL-2.1 kodu için katkıcı onayları [`legal/relicensing/`](legal/relicensing/) altında kayıtlıdır (BC-03).

## Yeni dosyalar

Bu repoda yazılan kaynak dosyalar ilk satırda (shebang varsa ondan sonra) SPDX başlığı taşıyabilir;
zorunlu değildir:

```rust
// SPDX-License-Identifier: Apache-2.0
```

## Dağıtılan paketler

Apache-2.0 madde 4(a) lisans metninin, madde 4(d) `NOTICE`'teki bildirimlerin dağıtılan kopyayla
birlikte verilmesini ister; `NOTICE`'teki MIT bildirimleri (Aperture, AIP) de bu kodun her
kopyasında bulunmalıdır. npm paketinde bu, tarball'da `dist/` ve `package.json`'ın yanında `LICENSE`
ve `NOTICE` bulunması demektir.

- `license` alanı `Apache-2.0` olan bir `packages/*` paketi `private` değilse ya da `files`'ta
  `LICENSE` veya `NOTICE` listeliyorsa, kökteki `LICENSE` ve `NOTICE`'in bayt bayt aynı kopyalarını
  düz dosya olarak commit'li tutar ve ikisini de `files`'ta listeler. Böylece `private` kaldırılan
  paket kopyasız yayımlanamaz; yayından önce eklenen kopyalar da aynı biçimde denetlenir. Kopyaları
  `pnpm license:write` yazar.
- Kopyalar tarball'a sıradan dosya olarak girer; sonuç paketleyen araca (`pnpm pack`, `npm pack`,
  `changeset publish`) ve script ayarına bağlı değildir. Seçilmeyen yollar:
  - `prepack` ile paketleme anında kopyalama: `.npmrc`'de `ignore-scripts=true` olan ortamda script
    çalışmaz ve tarball iki dosya olmadan, hatasız çıkar;
  - `files`'ta `../../LICENSE`: npm girdiyi atlar, pnpm paket dizininin dışını gösteren
    `package/../../LICENSE` girdisi yazar;
  - sembolik bağ: pnpm de npm de bağı tarball'a koymaz.
- `NOTICE` kırpılmadan kopyalanır. Madde 4(d) pakete ilgisiz bildirimleri çıkarmaya izin verir ama
  zorunlu tutmaz; paketlerde Aperture ve AIP'ten uyarlanan kod da var (ör. `packages/types`).
- Apache-2.0 olmayan paket (ör. `packages/agent-sdk`, MIT) kuralın dışındadır: `LICENSE` dosyası
  kaynağından gelir ve `pnpm license:write` ona dokunmaz.
- `pnpm license:check` kuralı denetler ([`pack-files.mjs`](../scripts/license/pack-files.mjs)); kök
  `LICENSE` ya da `NOTICE` değişince `pnpm license:write` kopyaları günceller.

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

`license:check` runtime bağımlılık lisanslarını, `THIRD_PARTY_LICENSES.md`'deki tablonun
güncelliğini ve paketlerdeki `LICENSE` / `NOTICE` kopyalarını denetler. Bağımlılık eklendiğinde ya
da kaldırıldığında ya da kök `LICENSE` / `NOTICE` değiştiğinde `license:write` çalıştırılıp sonuç
commit'lenir. CI: [`.github/workflows/license.yml`](../.github/workflows/license.yml).
