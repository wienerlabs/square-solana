# ADR 0011: Monorepo araçları: pnpm workspaces ve Turborepo

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar), Monorepo
  araçları satırı (2026-10-02)
- **Kapsam:** TS paketleri ve uygulamaları (`packages/*`, `apps/*`, `db`), kök araçlar ve CI

## Bağlam

Kaynaklar npm, npm workspaces ve yarn kullanıyordu
([§7](../analysis/square-solana-analysis.md#7-%C3%B6rt%C3%BC%C5%9Fmeler-ve-%C3%A7ak%C4%B1%C5%9Fmalar),
23. satır). Analiz pnpm ve Turborepo önerdi
([§9](../analysis/square-solana-analysis.md#9-%C3%B6nerilen-monorepo-yap%C4%B1s%C4%B1)) ve bunu
[§11](../analysis/square-solana-analysis.md#11-a%C3%A7%C4%B1k-sorular-faz-2ye-ge%C3%A7meden-%C3%B6nce-cevap-gerekiyor--12de-cevapland%C4%B1)'in
14. sorusunda sordu.

## Karar

1. TS tarafının monorepo araçları pnpm (workspaces) ve Turborepo'dur.
2. Paket adlandırma (`@squaresdk/solana-*`), ortak yapılandırma, test aracı ve sürümleme
   [ADR 0001](0001-ts-paket-adlandirma-ve-surumleme.md)'dedir; bu ADR onları tekrarlamaz.

## Gerekçe

Analizde ayrıca gerekçe yazılmadı.

## Sonuçlar

- Uygulandı: pnpm workspace ve Turborepo BC-01 (#1) ile kuruldu, sonraki issue'larla genişledi. Bugün
  workspace `packages/*`, `apps/*` ve `db`'dir (`pnpm-workspace.yaml`); Turborepo görevleri `generate`,
  `build`, `typecheck` ve `test`'tir (`turbo.json`); pnpm sürümü kök `package.json`'daki
  `packageManager` alanında (10.34.6) sabittir. Bağımlılıkların hangi kurulum script'lerinin çalışacağı
  `pnpm-workspace.yaml`'da açık kararla sınırlanır.
- Node 24 hattı `.nvmrc` (BC-43, #100) ve `engines.node >= 24` (BE-35, #102) ile sabittir.
- Lint kökte çalışır (`eslint . && prettier --check .`); Turborepo görevi değildir.
- TS CI'ı BE-01 ile kuruldu (`.github/workflows/packages.yml`) ve BE-03 (#17) ile genişler; Rust ve
  devre CI'ı BC-13'tedir (#13).
