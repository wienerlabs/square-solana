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
| `anchor-lang` | cargo | Apache-2.0 | runtime | `square-common`, `square-escrow`, `square-policy`, `square-program-tests`, `square-registry`, `square-verifier` | ✓ |
| `anchor-spl` | cargo | Apache-2.0 | runtime | `square-escrow` | ✓ |
| `base64` | cargo | MIT OR Apache-2.0 | dev | `square-program-tests` | ✓ |
| `groth16-solana` | cargo | MIT | runtime | `square-verifier` | ✓ |
| `litesvm` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `serde_json` | cargo | MIT OR Apache-2.0 | build | `square-common`, `square-program-tests` | ✓ |
| `solana-account` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-compute-budget-interface` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-instruction-error` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-keypair` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-loader-v3-interface` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-message` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-program-pack` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-sha256-hasher` | cargo | Apache-2.0 | runtime | `square-common`, `square-program-tests` | ✓ |
| `solana-signature` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-signer` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-system-interface` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-transaction` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `solana-transaction-error` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `spl-associated-token-account-interface` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `spl-token-interface` | cargo | Apache-2.0 | dev | `square-program-tests` | ✓ |
| `@a2a-js/sdk` | npm | Apache-2.0 | dev | `@squaresdk/solana-a2a` | ✓ |
| `@anchor-lang/core` | npm | (MIT OR Apache-2.0) | runtime | `@squaresdk/solana-a2a`, `@squaresdk/solana-identity`, `@squaresdk/solana-policy`, `@squaresdk/solana-sdk`, `@squaresdk/solana-web` | ✓ |
| `@anthropic-ai/sdk` | npm | MIT | runtime | `@squaresdk/solana-agent-sdk` | ✓ |
| `@changesets/cli` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `@eslint/js` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `@fontsource/open-runde` | npm | OFL-1.1 | runtime | `@squaresdk/solana-web` | ✓ |
| `@modelcontextprotocol/sdk` | npm | MIT | runtime | `@squaresdk/solana-mcp` | ✓ |
| `@noble/curves` | npm | MIT | dev | `@squaresdk/solana-policy` | ✓ |
| `@noble/hashes` | npm | MIT | runtime | `@squaresdk/solana-identity`, `@squaresdk/solana-policy`, `@squaresdk/solana-sdk`, `@squaresdk/solana-web` | ✓ |
| `@prisma/adapter-pg` | npm | Apache-2.0 | runtime | `@squaresdk/solana-db` | ✓ |
| `@prisma/client` | npm | Apache-2.0 | runtime | `@squaresdk/solana-db` | ✓ |
| `@redocly/cli` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `@solana/spl-token` | npm | Apache-2.0 | runtime | `@squaresdk/solana-sdk`, `@squaresdk/solana-web` | ✓ |
| `@solana/wallet-adapter-base` | npm | Apache-2.0 | runtime | `@squaresdk/solana-web` | ✓ |
| `@solana/wallet-adapter-phantom` | npm | Apache-2.0 | runtime | `@squaresdk/solana-web` | ✓ |
| `@solana/wallet-adapter-react` | npm | Apache-2.0 | runtime | `@squaresdk/solana-web` | ✓ |
| `@solana/wallet-adapter-react-ui` | npm | Apache-2.0 | runtime | `@squaresdk/solana-web` | ✓ |
| `@solana/wallet-adapter-solflare` | npm | Apache-2.0 | runtime | `@squaresdk/solana-web` | ✓ |
| `@solana/wallet-standard-chains` | npm | Apache-2.0 | runtime | `@squaresdk/solana-web` | ✓ |
| `@solana/web3.js` | npm | MIT | runtime | `@squaresdk/solana-a2a`, `@squaresdk/solana-agent-sdk`, `@squaresdk/solana-compliance-api`, `@squaresdk/solana-db`, `@squaresdk/solana-identity`, `@squaresdk/solana-policy`, `@squaresdk/solana-sdk`, `@squaresdk/solana-web` | ✓ |
| `@tailwindcss/postcss` | npm | MIT | dev | `@squaresdk/solana-web` | ✓ |
| `@testcontainers/postgresql` | npm | MIT | runtime | `@squaresdk/solana-a2a`, `@squaresdk/solana-db` | ✓ |
| `@testing-library/dom` | npm | MIT | dev | `@squaresdk/solana-web` | ✓ |
| `@testing-library/react` | npm | MIT | dev | `@squaresdk/solana-web` | ✓ |
| `@types/bn.js` | npm | MIT | dev | `@squaresdk/solana-policy`, `@squaresdk/solana-sdk` | ✓ |
| `@types/cors` | npm | MIT | dev | `@squaresdk/solana-compliance-api`, `@squaresdk/solana-prover` | ✓ |
| `@types/express` | npm | MIT | dev | `@squaresdk/solana-agent-sdk`, `@squaresdk/solana-compliance-api`, `@squaresdk/solana-prover` | ✓ |
| `@types/node` | npm | MIT | dev | `@squaresdk/solana-agent-sdk`, `@squaresdk/solana-compliance-api`, `@squaresdk/solana-mcp`, `@squaresdk/solana-monorepo`, `@squaresdk/solana-prover` | ✓ |
| `@types/pg` | npm | MIT | dev | `@squaresdk/solana-compliance-api`, `@squaresdk/solana-db` | ✓ |
| `@types/react` | npm | MIT | dev | `@squaresdk/solana-web` | ✓ |
| `@types/react-dom` | npm | MIT | dev | `@squaresdk/solana-web` | ✓ |
| `@types/swagger-jsdoc` | npm | MIT | dev | `@squaresdk/solana-compliance-api` | ✓ |
| `@types/swagger-ui-express` | npm | MIT | dev | `@squaresdk/solana-compliance-api` | ✓ |
| `@types/uuid` | npm | MIT | dev | `@squaresdk/solana-compliance-api` | ✓ |
| `@vitest/coverage-v8` | npm | MIT | dev | `@squaresdk/solana-a2a`, `@squaresdk/solana-identity`, `@squaresdk/solana-policy`, `@squaresdk/solana-prover`, `@squaresdk/solana-sdk` | ✓ |
| `axe-core` | npm | MPL-2.0 | dev | `@squaresdk/solana-web` | ❌ izinsiz / bilinmiyor |
| `bn.js` | npm | MIT | runtime | `@squaresdk/solana-policy`, `@squaresdk/solana-sdk` | ✓ |
| `bs58` | npm | MIT | runtime | `@squaresdk/solana-compliance-api`, `@squaresdk/solana-db`, `@squaresdk/solana-identity` | ✓ |
| `circomlibjs` | npm | GPL-3.0 | runtime | `@squaresdk/solana-compliance-api` | ⚠️ inceleme |
| `cors` | npm | MIT | runtime | `@squaresdk/solana-compliance-api`, `@squaresdk/solana-prover` | ✓ |
| `dotenv` | npm | BSD-2-Clause | runtime | `@squaresdk/solana-compliance-api` | ✓ |
| `eslint` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `eslint-config-prettier` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `express` | npm | MIT | runtime | `@squaresdk/solana-agent-sdk`, `@squaresdk/solana-compliance-api`, `@squaresdk/solana-prover` | ✓ |
| `globals` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `helmet` | npm | MIT | runtime | `@squaresdk/solana-compliance-api`, `@squaresdk/solana-prover` | ✓ |
| `jsdom` | npm | MIT | dev | `@squaresdk/solana-web` | ✓ |
| `next` | npm | MIT | runtime | `@squaresdk/solana-web` | ✓ |
| `next-themes` | npm | MIT | runtime | `@squaresdk/solana-web` | ✓ |
| `node-cache` | npm | MIT | runtime | `@squaresdk/solana-compliance-api` | ✓ |
| `pg` | npm | MIT | runtime | `@squaresdk/solana-compliance-api`, `@squaresdk/solana-db` | ✓ |
| `poseidon-lite` | npm | MIT | runtime | `@squaresdk/solana-policy` | ✓ |
| `prettier` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `prisma` | npm | Apache-2.0 | runtime | `@squaresdk/solana-db` | ✓ |
| `prom-client` | npm | Apache-2.0 | runtime | `@squaresdk/solana-prover` | ✓ |
| `react` | npm | MIT | runtime | `@squaresdk/solana-web` | ✓ |
| `react-dom` | npm | MIT | runtime | `@squaresdk/solana-web` | ✓ |
| `snarkjs` | npm | GPL-3.0 | runtime | `@squaresdk/solana-policy`, `@squaresdk/solana-prover` | ⚠️ inceleme |
| `stripe` | npm | MIT | runtime | `@squaresdk/solana-compliance-api` | ✓ |
| `swagger-jsdoc` | npm | MIT | runtime | `@squaresdk/solana-compliance-api` | ✓ |
| `swagger-ui-express` | npm | MIT | runtime | `@squaresdk/solana-compliance-api` | ✓ |
| `tailwindcss` | npm | MIT | dev | `@squaresdk/solana-web` | ✓ |
| `tsx` | npm | MIT | dev | `@squaresdk/solana-compliance-api` | ✓ |
| `turbo` | npm | MIT | dev | `@squaresdk/solana-monorepo` | ✓ |
| `tweetnacl` | npm | Unlicense | runtime | `@squaresdk/solana-compliance-api` | ✓ |
| `typescript` | npm | Apache-2.0 | dev | `@squaresdk/solana-monorepo` | ✓ |
| `typescript-eslint` | npm | MIT | runtime | `@squaresdk/solana-config` | ✓ |
| `uuid` | npm | MIT | runtime | `@squaresdk/solana-compliance-api` | ✓ |
| `vitest` | npm | MIT | dev | `@squaresdk/solana-a2a`, `@squaresdk/solana-db`, `@squaresdk/solana-identity`, `@squaresdk/solana-policy`, `@squaresdk/solana-prover`, `@squaresdk/solana-sdk`, `@squaresdk/solana-types`, `@squaresdk/solana-web` | ✓ |
| `yaml` | npm | ISC | dev | `@squaresdk/solana-sdk`, `@squaresdk/solana-types` | ✓ |
| `zod` | npm | MIT | runtime | `@squaresdk/solana-a2a`, `@squaresdk/solana-compliance-api`, `@squaresdk/solana-mcp`, `@squaresdk/solana-prover`, `@squaresdk/solana-types`, `@squaresdk/solana-web` | ✓ |

**Özet:** 71 npm, 21 Cargo doğrudan bağımlılık; lisans dağılımı: 51× MIT, 31× Apache-2.0, 3× MIT OR Apache-2.0, 2× GPL-3.0, 1× BSD-2-Clause, 1× ISC, 1× MPL-2.0, 1× OFL-1.1, 1× Unlicense.

**Mainnet öncesi hukuki inceleme gerektirenler:**
- `circomlibjs` (npm) — GPL-3.0. Poseidon hash (devreyle aynı sabitler); yalnızca apps/compliance-api (BE-02). Yayınlanan bir pakette yok; snarkjs ile aynı onay kapsamında.
- `snarkjs` (npm) — GPL-3.0. Groth16 ispatı üretimi; çalışma zamanında yalnızca apps/prover (BE-11). @squaresdk/solana-policy (BE-10) yalnızca testlerde kullanır: createLocalProver snarkjs içermez, çağıranın kurduğu groth16 nesnesini alır. Servis imajı dağıtılmadan önce hukuki onay gerekir.
<!-- license-inventory:end -->

Kaynak projelerin (Aperture, AIP, Covenant) kendi lisansları ve telif bildirimleri
[`NOTICE`](../NOTICE)'tedir.
