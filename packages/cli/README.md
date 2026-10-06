# @squaresdk/solana-cli

Square'in komut satırı aracı: `squaresdk-solana`. Akışın 8 adımı, uyuşmazlık ve did:aip çözümü; JSON çıktı modu,
küme ve keypair yapılandırması (BE-30, [ADR 0025](../../docs/decisions/0025-cli-komut-adi-ve-yapilandirma.md)).

```bash
pnpm --filter @squaresdk/solana-cli build
node packages/cli/dist/bin.js --help                      # paket kurulunca: squaresdk-solana --help
squaresdk-solana job create --help                        # bir komutun seçenekleri
```

Komut referansı, yapılandırma, çıktı ve çıkış kodları: [docs/cli.md](../../docs/cli.md). Devnet'te 8 adımın
komutları ve imzaları: [docs/deploy/cli-devnet.md](../../docs/deploy/cli-devnet.md).

| Grup | Komutlar |
|---|---|
| `agent` | `register`, `resolve` |
| `screening` | `record` |
| `policy` | `secret`, `commit`, `buyers`, `watch` |
| `job` | `create`, `fund`, `accept`, `submit`, `finalize`, `cancel`, `show` |
| `claim` | `list`, `buy`, `cancel` |
| `proof` | `bind` |
| `dispute` | `raise`, `vote`, `execute`, `lapse`, `escalate` |

- **İmza:** Her komut tx'i SDK'nın akışıyla kurar, `--keypair` (rol) ve `--fee-payer` (ücret ve rent) ile imzalar,
  gönderir ve onayını bekler. Zincire girmeden blockhash'i dolan tx yeniden kurulur.
- **İspat:** `proof bind` ve `policy watch` ispatı uzak prover'dan alır (Square API ya da `apps/prover`); CLI snarkjs
  içermez.
- **Sırlar:** Politika sırrı ve alıcı listesi dosyaları 0600 yazılır, üstlerine yazılmaz. Prover'ın API anahtarı
  yalnızca ortamdan okunur.

## Testler

```bash
pnpm --filter @squaresdk/solana-cli build      # referans testi dist'i kullanır
pnpm --filter @squaresdk/solana-cli test
node packages/cli/scripts/reference.mjs        # docs/cli.md'yi yeniden üretir
```

Komutların tx'leri bellekteki zincirde kurulur ve talimatları program coder'ıyla çözülüp denetlenir; yapılandırma
önceliği, çıktı biçimi ve gönderim (imzacılar, program hatası, blockhash'in dolması) ayrı testlidir.
