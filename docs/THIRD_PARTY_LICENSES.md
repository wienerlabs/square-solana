# Üçüncü taraf lisans envanteri

Square **Apache-2.0** altındadır ([`LICENSE`](../LICENSE)). Bu belge, doğrudan üçüncü taraf
bağımlılıkların lisanslarını Apache-2.0 ile dağıtıma uygunluk açısından kayıt altına alır;
hukuki karar gerektiren her lisans unutulmak yerine burada izlenir. Kurallar:
[`licensing.md`](licensing.md).

- **Kapsam:** pnpm workspace'indeki her paketin (kök dahil) ve Cargo workspace'indeki her crate'in
  doğrudan bağımlılıkları. Geçişli bağımlılıklar kapsam dışıdır.
- **Kaynak:** npm lisansları kurulu paketlerin `package.json`'ından, Cargo lisansları
  `cargo metadata`'dan okunur.
- **Kapı:** CI `pnpm license:check` çalıştırır ve izinsiz ya da bilinmeyen lisanslı her runtime
  bağımlılıkta kırmızıya döner; aşağıdaki tablo güncel değilse de kırmızıya döner.

Aşağıdaki bölüm üretilir; elle düzenlenmez. Yeniden üretmek için:

```bash
pnpm install
pnpm license:write
```

<!-- license-inventory:begin -->
| Paket | Ekosistem | Lisans | Kapsam | Kullanan | Durum |
|---|---|---|---|---|---|
| `anchor-lang` | cargo | Apache-2.0 | runtime | `aip-registry`, `policy-registry`, `verifier` | ✓ |
| `groth16-solana` | cargo | MIT | runtime | `verifier` | ✓ |
| `sha2` | cargo | MIT OR Apache-2.0 | runtime | `policy-registry` | ✓ |
| `@changesets/cli` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `@coral-xyz/anchor` | npm | (MIT OR Apache-2.0) | runtime | `@squaresdk/solana-sdk` | ✓ |
| `@eslint/js` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `@redocly/cli` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `@solana/web3.js` | npm | MIT | runtime | `@squaresdk/solana-identity`, `@squaresdk/solana-policy`, `@squaresdk/solana-sdk` | ✓ |
| `@types/node` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `eslint` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `eslint-config-prettier` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `globals` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `prettier` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `turbo` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `typescript` | npm | Apache-2.0 | dev | `@squaresdk/solana-monorepo` | ✓ |
| `typescript-eslint` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `vitest` | npm | MIT | dev | `@squaresdk/solana-sdk`, `@squaresdk/solana-types` | ✓ |
| `yaml` | npm | ISC | dev | `@squaresdk/solana-sdk`, `@squaresdk/solana-types` | ✓ |
| `zod` | npm | MIT | runtime | `@squaresdk/solana-types` | ✓ |

**Özet:** 16 npm, 3 Cargo doğrudan bağımlılık; lisans dağılımı: 14× MIT, 2× Apache-2.0, 2× MIT OR Apache-2.0, 1× ISC.
<!-- license-inventory:end -->

Kaynak projelerin (Aperture, AIP, Covenant) kendi lisansları ve telif bildirimleri
[`NOTICE`](../NOTICE)'tedir.
