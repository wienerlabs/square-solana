# @squaresdk/solana-cctp

CCTP relayer'ın çekirdeği (BE-26). Tasarım: [docs/design/cctp-funding.md](../../docs/design/cctp-funding.md#relayer-be-26).

| Dışa aktarım | Kullanan | İş |
|---|---|---|
| `createRegistrar` | API `POST /v1/cctp/transfers` | Burn tx'ini job'a bağlar: job `Open`, mint'i USDC, `institution`'ı istek sahibi. Kaynak tx'i başına tek satır; aynı burn aynı job'a yeniden kaydedilirse aynı satır |
| `createFundTxBuilder` | API `POST /v1/cctp/transfers/{id}/tx` | Kurumun imzalayacağı tx: mesaj teslim edilmediyse mint + `fund_job` tek tx'te (iki ALT), edildiyse yalnızca `fund_job` |
| `createCctpRelayer` | Keeper | Durum makinesi: `pendingAttestation` → `attested` → `received` → `funded` (ya da `failed`) |
| `createTransferStore`, `toView` | API, keeper | `cctp_transfers` deposu ve sözleşmedeki `CctpTransfer` görünümü |
| `parseCctpSettings` | API, keeper | Circle'ın programları ve kaynak domain başına CCTP ALT'ı (`domain:adres`, virgülle) |

Relayer kurumun anahtarını tutmaz: `fund_job`'u kurum imzalar. Relayer attestation'ı izler, gerekirse
`receive_message`'ı kendi cüzdanıyla gönderir (mint kurumun USDC hesabına) ve fonlamayı zincirden izler. Her adım
zincirden ya da Circle'ın servisinden yeniden okur: yarıda kalan tur aynı mesajı ikinci kez göndermez.

## Testler

`pnpm --filter @squaresdk/solana-cctp test`: depo, kayıt, kurumun tx'i ve relayer gerçek Postgres'te (Testcontainers,
Docker gerekir), zincir bellekte (`test/helpers/chain.ts`), Circle'ın servisi gerçek yanıt biçimiyle (BC-36 devnet
koşusunun imzalanmış mesajı).

Uçtan uca devnet koşusu (`test/devnet.e2e.test.ts`) yalnızca ortamla çalışır; anahtarlar repoda tutulmaz:

```bash
CCTP_E2E_SEPOLIA_KEY=<{"privateKey":"0x…"} dosyası> \
CCTP_E2E_INSTITUTION=<kurum keypair'i> CCTP_E2E_RELAYER=<relayer keypair'i> \
CCTP_E2E_AGENT_RECORD=<screening'i temiz agent kaydı> \
pnpm --filter @squaresdk/solana-cctp exec vitest run test/devnet.e2e.test.ts
```

Ağ, programlar ve ALT'lar `scripts/deploy/networks/devnet.json` ve `Anchor.toml`'dandır. Koşu Sepolia'da iki kez
1 USDC yakar (hızlı kesinlik): kurumun tek tx'i ve relayer'ın teslimi ([deploy kaydı](../../docs/deploy/devnet.md#cctp-relayer-be-26)).
