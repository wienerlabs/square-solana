# CCTP ile fonlama (BC-36)

**Issue:** BC-36 (#77) · **Program sözleşmesi:** v0.5.1 ([§7](program-interface.md#7-m5m6-taslakları)) · **SDK:** `@squaresdk/solana-sdk` `cctp`, `flow.receiveAndFundJob`

USDC'si başka bir zincirde (Ethereum, Base, Arbitrum …) duran kurum, bir Square job'unu köprü kullanmadan
fonlar. Circle'ın Cross-Chain Transfer Protocol'ü (CCTP V2) USDC'yi kaynak zincirde yakar ve Circle'ın
attestation'ıyla Solana'da aynı USDC'yi mint eder. Square escrow'unun ayrı bir talimatı yoktur: mint edilen
USDC kurumun token hesabına düşer. `fund_job` onu aynı tx'te vault'a alır.

## Akış

| Adım | Nerede | Kim | Ne |
|---|---|---|---|
| `depositForBurn` | Kaynak zincirin `TokenMessengerV2`'si | Kaynak cüzdan | Tutarı Solana (domain 5) için yakar. Mint alıcısı kurumun Solana'daki USDC token hesabıdır, sahibi değil. Çağıran sınırlanmaz (`destinationCaller` sıfır) |
| Attestation | `iris-api(-sandbox).circle.com` | Circle | Burn istenen kesinliğe ulaşınca mesajı imzalar (`/v2/messages/{kaynak}?transactionHash=…`) |
| `receive_message` + `fund_job` | Solana, tek tx | Kurum (`caller`) | Circle'ın `MessageTransmitterV2`'si mesajı doğrular, nonce'u kullanılmış işaretler ve `TokenMessengerMinterV2` USDC'yi kurumun hesabına mint eder. Escrow'un `fund_job`'u job'un tutarını o hesaptan vault'a alır |

`create_job` önceden yapılır; job'un tutarı mint edilecek tutar ya da kurumun hesabında zaten olan bakiyeyle
karşılanabilecek bir tutardır. Fonlamanın kuralları değişmez: `Open` iş, iki tarafın temiz screening kaydı ve
Travel Rule eşiği.

## Kesinlik ve ücret

| Kesinlik | `minFinalityThreshold` | Süre (Ethereum) | Ücret |
|---|---|---|---|
| Standart | 2000 | ~15–20 dakika | 0 |
| Hızlı | 1000 | ~1 dakika | Servisin baz puanı (Sepolia → Solana: 1 bps, 2026-10-06), mint edilenden düşülür |

Ücret servisten okunur (`/v2/burn/USDC/fees/{kaynak}/{hedef}`). `maxFee` baz puanın tutardaki karşılığıdır,
yukarı yuvarlanır. Mint edilen `amount − feeExecuted`'dir (`cctpMintedAmount`); job hızlı kesinlikte bu
tutarla açılır.

## SDK

- **`decodeCctpMessage`:** `MessageV2` başlığı ve `BurnMessageV2` gövdesi, büyük uçlu ve sabit konumlu. Bu
  doküman nonce, kaynak domain, yakılan token, mint alıcısı, tutar ve alınan ücret alanlarını kullanır.
  Attestation'ı alınmış kopya teslim edilir: event'teki kopyada nonce ve ücret sıfırdır.
- **`receiveMessageInstruction`:** Circle'ın IDL'i SDK'ya alınmaz.
  - **Veri:** `sha256("global:receive_message")[..8]` ve borsh `{ message, attestation }`.
  - **Hesaplar:** Talimatın 9 hesabı ve `handle_receive_finalized_message`'ın 11 hesabı, Circle'ın sırasıyla.
  - **PDA tohumları:** Circle'ın: `used_nonce` mesajın nonce'u, `remote_token_messenger` ve `token_pair`
    kaynak domain'in ondalık yazımı (`"0"`).
  - **Reddedilenler:** Hedefi Solana olmayan, kaynağı bağlamdaki domain olmayan ve başka token'ı yakan mesaj.
- **`flow.receiveAndFundJob`:** İki talimatı tek tx'te kurar.
  - **Ön koşullar:** Mesajın mint alıcısı kurumun USDC hesabı olmalı, job'un mint'i mint edilen USDC olmalı.
  - **Compute sınırı:** `fundJob` profili artı `CCTP_RECEIVE_COMPUTE_UNITS`.
  - **Dönüş:** Mint edilen tutar (`minted`).
- **`cctpLookupTableAddresses`:** CCTP ALT'ının 13 adresi: iki program ve `receive_message`'ın mesaja bağlı
  olmayan hesapları.
- **`fetchCctpFeeRecipient`:** `TokenMessenger.fee_recipient`.

## Tx boyutu ve compute

Tek tx, Square ALT'ı ([tx-budget.md](tx-budget.md)) ve kaynak zincirin CCTP ALT'ıyla birlikte sığar:

| Ölçüm | Değer |
|---|---|
| Mesaj ve attestation | 376 + 130 bayt (iki attester imzası) |
| Tx (iki ALT'la, imzalı) | 1 082 bayt; sınır 1 232 |
| Simülasyon (mint + fonlama) | 202 865 CU |
| Compute sınırı | 480 000 CU: `fundJob` 90 000 + `CCTP_RECEIVE_COMPUTE_UNITS` 390 000 |

`receive_message` Circle'ın programı olduğu için Square'in LiteSVM ölçümlerine girmez. Payı devnet'te
ölçüldü: yalnızca `receive_message` içeren 18 işlemde 178 061 – 194 880 CU. BC-28'in kuralıyla en yükseğin iki
katı, 10 bine yukarı yuvarlanmış: 390 000.

## Hata ve kurtarma

| Nerede durdu | Para nerede | Ne yapılır |
|---|---|---|
| Burn'den önce (ücret tutarı yutuyor, allowance) | Kaynak cüzdanda | Tutar düzeltilir; hiçbir şey yakılmadı |
| Burn'den sonra, attestation'dan önce | Kaynak zincirde yakıldı, Solana'da henüz yok | Burn hash'iyle attestation yeniden sorgulanır; mesaj süresi dolmadıkça imza gelir |
| Attestation'dan sonra, tx düştü (RPC, blockhash) | Attestation'da | Tx aynı mesajla yeniden kurulur; nonce kullanılmadıkça mint edilmemiştir |
| Nonce başkası tarafından kullanıldı (ayrı bir teslim) | Kurumun USDC hesabında | `fund_job` tek başına (`flow.fundJob`) |
| `fund_job` reddedildi (screening, Travel Rule, durum) | Tx bütünüyle geri alındı: mint de olmadı | Sebep giderilip aynı mesajla yeniden denenir |

Tek tx'in yararı son satırdır: fonlama düşerse mint de düşer. USDC kurumun hesabında yarım kalmış bir
adımda beklemez.

## Devnet örneği (2026-10-06)

`scripts/deploy/cctp-burn.mjs` ve `scripts/deploy/cctp-fund-job.mjs` ile ([kayıt](../deploy/devnet.md#cctp-ile-fonlama-bc-36)):

| Adım | Tx |
|---|---|
| Sepolia `approve` | [`0x91ab0248…`](https://sepolia.etherscan.io/tx/0x91ab02480f5beb7c26cc564790386c2c056fddc2fd595843b95bb949c132ac77) |
| Sepolia `depositForBurn` (5 USDC, standart) | [`0x579e6758…`](https://sepolia.etherscan.io/tx/0x579e67589ff91e49ce72c499f01414a7c15d9f7dd6399d541f6bd988223c6911) |
| Attestation | nonce `0xab4ef092ac8246464a4c1e2750038a96b4b5b1d2655a5198dc7e6548b3bec063`, ücret 0 |
| Solana `create_job` (5 USDC) | [`4UnXtueH…`](https://explorer.solana.com/tx/4UnXtueHmZFGi4Ac9dKHYq4juvP7fEL3sWZNEUceefDKrC8neMdiP32NjTNcxHzWtcehDSkSkDvP9LusLVqvRH6S?cluster=devnet) |
| Solana `receive_message` + `fund_job` (tek tx) | [`2qfMga78…`](https://explorer.solana.com/tx/2qfMga78K7aTAx9ichvTyiMTeUEr3DzzJZNVB5nyNqpX5qe5q3nNeq5XQHyMdVEXooy6NfjYmZ13o1cmV3xg7rq2?cluster=devnet) |

Sonuç: job `DYog8N8bftM5cAY2xop7BzLjMmZqgW9wTAJek4LXbfGC` `Funded`, vault'ta 5 000 000 (5 USDC). Mesaj
`packages/sdk/test/fixtures/cctp-sepolia-to-solana.json`'da, Circle'ın kendi çözümüyle birlikte; SDK'nın
çözümü onunla alan alan karşılaştırılır.

## Adresler

Circle'ın programları ve kaynak zincir sözleşmeleri ağın yapılandırmasındadır
(`scripts/deploy/networks/<ağ>.json`, `cctp`):
- **Solana programları:** `MessageTransmitterV2` `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`,
  `TokenMessengerMinterV2` `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`. İkisi de devnet'te
  `solana program show` ile doğrulandı.
- **Sepolia:** `TokenMessengerV2` `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, USDC
  `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. Devnet'teki `token_pair` hesabı bu USDC'yi Solana devnet
  USDC'sine eşler.

## Kaynak

Arc Square'in `docs/design/cctp-funding.md`'si (EVM, Arc hedefi) akışın ve hata tablosunun yapısını verdi.
Solana tarafının hesapları ve PDA tohumları Circle'ın `solana-cctp-contracts` reposundaki V2 örneğindendir
(Apache-2.0; kod alınmadı).
