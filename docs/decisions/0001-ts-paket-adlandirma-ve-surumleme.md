# ADR 0001 — TS paketlerinin adlandırılması, sürümlenmesi ve yayını

- **Durum:** Kabul edildi
- **Issue:** BE-01 (#15)
- **Kapsam:** Bu repodaki tüm TypeScript / JavaScript paketleri ve uygulamaları

## Bağlam

Square'in Solana sürümü birden çok TS paketi (types, sdk, identity, policy, …) ve uygulama (api, indexer, keeper, prover, web) içerecek. `square` adı ve `@square/*` npm kapsamı Square Inc.'e ait. Arc sürümü de `@squaresdk` kapsamını kullanmayı planlıyor; iki sürümün paketleri aynı kapsamda çakışmamalı.

## Karar

1. **Adlandırma.** Repodaki her `package.json` adı `@squaresdk/solana-<ad>` biçimindedir (ör. `@squaresdk/solana-sdk`, `@squaresdk/solana-config`, `@squaresdk/solana-circuit-payment-compliance`). `square` ve `@square/*` kullanılmaz. Kural `scripts/check-package-names.mjs` ile CI'da denetlenir (`pnpm check:names`).
2. **Uygulamalar.** `apps/*` altındaki paketler aynı adlandırmayı kullanır ve `"private": true` taşır; npm'e yayımlanmaz.
3. **Ortak ayarlar.** tsconfig, ESLint ve Prettier ayarları `@squaresdk/solana-config` paketindedir; paketler `@squaresdk/solana-config/tsconfig.base.json`'u genişletir, kök `eslint.config.js` ve `prettier.config.js` bu paketi kullanır.
4. **Test aracı.** Standart test aracı vitest'tir. Ayrı npm projesi olan devre dizini (`circuits/payment-compliance`) kendi `node:test` paketini korur.
5. **Sürümleme.** Paketler [changesets](https://github.com/changesets/changesets) ile, birbirinden bağımsız semver olarak sürümlenir. Yayımlanan bir paketi değiştiren PR bir changeset dosyası ekler (`pnpm changeset`); `pnpm version-packages` sürümleri ve CHANGELOG'ları günceller. 1.0.0'a kadar geriye uyumsuz değişiklikler MINOR'u artırır. API / SDK sözleşme sürümü (`API_CONTRACT_VERSION`, `docs/design/api-sdk-contract.md`) `@squaresdk/solana-types` sürümüyle uyumlu tutulur.
6. **Yayın.** Yayın `changeset publish` ile CI'dan yapılır. Ön koşullar: `@squaresdk` npm org'u ve ekip üyelerinin yayın yetkisi, CI'da `NPM_TOKEN` gizli değişkeni. Ön koşullar tamamlanana kadar paketler `"private": true` kalır; yayın iş akışı ön koşullarla birlikte eklenir.

## Gerekçe

- `solana-` öneki, Arc sürümünün `@squaresdk/*` paketleriyle ad çakışmasını önler ve paketin hangi zincir için olduğunu gösterir.
- changesets, monorepo'da paket başına sürüm ve CHANGELOG üretir; repoda changeset-bot zaten kurulu. Etiket tabanlı tek sürüm ise birbirinden bağımsız ilerleyen paketlerde gereksiz sürüm artışı üretir.

## Sonuçlar

- Yeni paket eklerken ad kuralı CI'da zorunludur.
- Paketlerin npm'e çıkması `@squaresdk` org'una ve `NPM_TOKEN`'a bağlıdır.
