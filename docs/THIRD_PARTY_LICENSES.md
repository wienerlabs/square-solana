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
| `anchor-lang` | cargo | Apache-2.0 | runtime | `policy-registry`, `square-escrow-contract`, `square-policy-contract`, `square-registry-contract`, `square-verifier-contract`, `verifier` | ✓ |
| `anchor-spl` | cargo | Apache-2.0 | runtime | `square-escrow-contract` | ✓ |
| `groth16-solana` | cargo | MIT | runtime | `verifier` | ✓ |
| `sha2` | cargo | MIT OR Apache-2.0 | runtime | `policy-registry` | ✓ |
| `@coral-xyz/anchor` | npm | (MIT OR Apache-2.0) | runtime | `@squaresdk/solana-sdk` | ✓ |
| `@redocly/cli` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `@solana/web3.js` | npm | MIT | runtime | `@squaresdk/solana-identity`, `@squaresdk/solana-policy`, `@squaresdk/solana-sdk` | ✓ |
| `@types/node` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `turbo` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `typescript` | npm | Apache-2.0 | dev | `@squaresdk/solana-monorepo` | ✓ |
| `yaml` | npm | ISC | dev | `@squaresdk/solana-sdk`, `@squaresdk/solana-types` | ✓ |
| `zod` | npm | MIT | runtime | `@squaresdk/solana-types` | ✓ |

**Özet:** 8 npm, 4 Cargo doğrudan bağımlılık; lisans dağılımı: 6× MIT, 3× Apache-2.0, 2× MIT OR Apache-2.0, 1× ISC.
<!-- license-inventory:end -->

Kaynak projelerin (Aperture, AIP, Covenant) kendi lisansları ve telif bildirimleri
[`NOTICE`](../NOTICE)'tedir.
