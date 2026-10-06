# Devnet deploy kaydı

**Issue:** BC-09 (#9), BC-30 (#38) · **Runbook:** [upgrade.md](../runbooks/upgrade.md) · **RPC:** `https://api.devnet.solana.com`

Square programlarının devnet'teki kimlikleri, upgrade authority'si ve kurulumu. Adres, imza ve hash'ler buraya
yazılır; anahtarlar yazılmaz.

## Program kimlikleri (BC-09)

Program sözleşmesi v0.5.0. Program keypair'leri secret store'dadır, repoda değildir.

| Program | Kimlik |
|---|---|
| `square_registry` | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` |
| `square_policy` | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` |
| `square_verifier` | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` |
| `square_escrow` | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |

## Squads v4 multisig (BC-09, 2026-10-06)

`scripts/deploy/squads-multisig.mjs create` ile kuruldu, `show` ile doğrulandı.

| Ayar | Değer |
|---|---|
| Multisig | `3ucyX6nmbz9ytRVWr3wrYQD2try58Jy1xCyuNo8q6PD5` |
| Vault (indeks 0): upgrade authority ve config admin'i | `J73BpSowEwQWqXYHzKBnLn3kfn1EJQF71qEF38dkmwqQ` |
| Eşik | 2 / 3 |
| Time lock | 0 |
| Config authority | yok (özerk: üye ve eşik değişikliği de multisig oylamasıyla) |
| Kurulum imzası | `1wkteyMnzC3dj91mJptzvLQmvttshyFLP3See9VJDDuitBVzj1NXrExtrwGY4uSARhsUu8rf9xPc5iZAWmxJQR5` |

| Üye | Adres | İzinler |
|---|---|---|
| MuhammedAkinci | `DPF8Myr3engeVLgCvxhTmLZQANYb7rKA8aSvZpz9cM3q` | Initiate, Vote, Execute |
| mehmethayirli | `EZggdp7BCPLU84UBz2WFw4yvEC6KM3ZH6mjPANYQRPmQ` | Initiate, Vote, Execute |
| kh0ra | `4DepaL4Dqp6NKzz5oHFjMY3b6FCDvFrqABd62YsUohtE` | Initiate, Vote, Execute |

Üye anahtarları yalnızca devnet için üretildi ve sahiplerine verildi. Mainnet multisig'i üyelerin kendi
anahtarlarıyla BC-42'de (#98) kurulur.

## Deploy (BC-30, 2026-10-06)

Programlar commit `4509884`'ün (main, BC-09) verifiable build'iyle deploy edildi.
- **İmaj:** `solanafoundation/solana-verifiable-build:4.1.2@sha256:2e0b78f44ee76612e9260c7c988570c5e14de6fbd93e0ab07115ec7054473b4f`
- **Araç:** `solana-verify build`, sürüm 0.5.0.
- **Hash doğrulaması:** Zincirdeki hash'ler (`solana-verify get-program-hash`) derlemenin hash'leriyle aynı.
- **Upgrade authority:** Deploy'dan sonra vault'a devredildi; `solana program show` ile doğrulandı.
- **Yükseltme payı:** `--max-len` program boyutunun 1,5 katıdır; yükseltmelere yer bırakır.

| Program | Executable hash | Program data | Deploy imzası | Upgrade authority |
|---|---|---|---|---|
| `square_registry` | `8b5781c0f35756675df2373b5ea97547c3e39809af7de8363aea5636d73b2580` | 413 220 bayt | `4J5PekJcjHy65DdqxKXuR7MMha6gXcWiW5fKQCYVVbG621NYaixni6sLds4EXunHf5ppmkp12uoty7uENXkGLwje` | vault |
| `square_policy` | `22d6dbd59527d98529016c8e8ae721d54466893c6730fc3bbf69641d68b8c12b` | 294 408 bayt | `2EtXCCUypFzz3MbU4xkXVRnD3YakgfujeTFd7P21BzZ9GzPBLhFk7FfkrzbJifL4XcYmsHRcbC24C3mNDaLkmzQU` | vault |
| `square_verifier` | `588c704d39b7f137c3e99c981145b28921b12db4163484af1d14aa6fbf8233f7` | 469 968 bayt | `2NEFVw9AyQjHmBgkMw9N7TDZ8GW7QTVBG8ew3CqEj57j61QM4jgoUqupr6Qnn789xYQsXYXX775B4ez3eLWeuDGV` | vault |
| `square_escrow` | `0cd1eb813c218b9aed4fd18fe6eb115dc644010924a5b94d33d64da826289754` | 857 592 bayt | `2rBNmDDTTUGLP7AYDPVg8Dum2iiEmdnXwPdR2cmPRxXbDz2DaEcWPzworam8FU6n2vH6hYbzVTXRa2k7C1qegkcb` | vault |

Deploy anahtarı (`3qJFqe1YCEteR4mo6X325vUo5ePFmpPYmV6fhD4uSZUC`) yalnızca ücret, buffer rent'i ve ALT için kullanıldı;
hiçbir programın ya da config'in yetkilisi değildir.

## Config'ler (vault imzasıyla)

`scripts/deploy/init-configs.mjs --network devnet`; değerler [`scripts/deploy/networks/devnet.json`](../../scripts/deploy/networks/devnet.json).
Her config bir Squads vault işlemidir: MuhammedAkinci ve mehmethayirli onayladı, MuhammedAkinci yürüttü. Üç
config'in `admin`'i vault'tur (`J73BpSowEwQWqXYHzKBnLn3kfn1EJQF71qEF38dkmwqQ`). Değerler `--show` ile
zincirden okundu.

| Config | Adres | Squads işlemi | Yürütme imzası |
|---|---|---|---|
| `RegistryConfig` | `EGDLUwrsTTFJaXEx1iHkUxm7SSdD4rnf1FG6CT9xRyj6` | 1 | `HXKymer2FyPEw2eKeza3Cadiqk6E7vj6cWnSo7QRFcg43dNUc8NyJFxTspZGWUxbQ48TVeLwmYeZNgsRQp6Myon` |
| `VerifierConfig` | `BM8WBhmvwyM3GdsHHQPAVg3XfcKE8e2q5AARjuCFmdX2` | 2 | `chupCeGVaLXsUfGutRAJvaifPuUYY4xEioJRUtdki2JYbRQDXC1pU6yvuWTW7bnydtKXV8WyDFMGKUvL6oByfX9` |
| `EscrowConfig` | `4rvvBywr8aT5o65g9wWdn3UoQ6YtFGpTLBBn1sQCKZDA` | 3 | `zRpVFdmGqBQY6hR4RARruoPi9i6anT9M3FE7qHvPiMumusFSkVWivvTKbGZXkq5Pyr2fraWwbyiENXyMqDibxgU` |

| Değer | Devnet |
|---|---|
| Screener authority (BE-16 servisinin imza anahtarı) | `48DGxja6FefZHhZ8e5ynLKWLqxb1pVfiHFUVg1Jrm54b` |
| Screening ömrü | 2 592 000 sn (30 gün) |
| MPP authority (BC-37) | `CPwxS6VAy25B9xFKGKjNkXBmFcztNDea68J76SDeTn6c` |
| Settlement mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle devnet USDC) |
| Arbitrator'lar | üç üye cüzdanı, eşik 2 |
| Challenge süresi | 60 sn – 604 800 sn (7 gün) |
| Bond | %10, en az 1 USDC (`1000000`) |
| Keeper ücreti | 50 bps |
| İspatsız bekleme (`proof_timeout_secs`) | 86 400 sn (1 gün) |
| Dispute zaman aşımı | 604 800 sn (7 gün) |
| Travel Rule eşiği | 1 000 USDC (`1000000000`) |
| Doğrulama anahtarı sürümü (`vk_version`) | 1 |

Screener ve MPP authority anahtarları devnet için üretildi, secret store'dadır. Eşik ve süreler devnet içindir;
mainnet değerleri BC-42'de (#98) verilir.

## Square ALT

`scripts/deploy/create-lookup-table.mjs --network devnet`. Adresler SDK'nın `squareLookupTableAddresses`'ıdır. Tablo
kurulduktan sonra donduruldu: authority'si yoktur, değişmez. Servislerde `API_LOOKUP_TABLE`.

| | |
|---|---|
| ALT | `3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG` |
| Kurulum imzası | `128STqCMvKzRuo4ZsmTRHWwAXU52nkhBDzabFkJd8UTHBZvk8fXAwEwaXrNiCinC6APas9bLw4TMeszyP8T8xUKf` |
| Dondurma imzası | `5pp1x7hSMjEqpw1Fc3V6u2EjMwuLV3hFSDRAMJ7X7VKqcfZ6kM9ztYLtYmKHbYvwZN8HCLP6HFX219xXbTHFUBv8` |
| Adresler (13) | dört program, üç config PDA'sı, `escrow_authority` PDA'sı (`GyjbViCNwcPRJptkQvkpwKmwiyUMy9StaPJaoALSZ6ix`), settlement mint'i, System, Token, Token-2022, Instructions sysvar |

## Servislerin devnet değerleri

| Değişken | Değer |
|---|---|
| `SQUARE_PROGRAM_ID_REGISTRY` | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` |
| `SQUARE_PROGRAM_ID_POLICY` | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` |
| `SQUARE_PROGRAM_ID_VERIFIER` | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` |
| `SQUARE_PROGRAM_ID_ESCROW` | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |
| `API_LOOKUP_TABLE` | `3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG` |
| `SQUARE_LOOKUP_TABLE` (web, ağ sayfası) | `3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG` |

## CCTP ile fonlama (BC-36)

Ethereum Sepolia'dan Solana devnet'e CCTP V2 ile 5 USDC: tasarım ve tx örnekleri
[cctp-funding.md](../design/cctp-funding.md).

| | |
|---|---|
| CCTP ALT (Sepolia) | `2Zg2NRhkLqdFHq3SZcxqHmZkTTLXmKx4yeZNbfSqPbUY`. `create-lookup-table.mjs --cctp sepolia` kurdu ve dondurdu (kurulum `3w8gzZM8…`, dondurma `4RBBrn5S…`) |
| Kullanılmayan ikinci tablo | `D4znhujirRMcecDhB3AvjbHGChZ54RYMrmW7EJKpoizJ`. Aynı adreslerle önceki bir denemede kuruldu; o denemenin çıktısı kaydedilmedi. Dondurulduğu için kapatılamaz; kullanılmaz |
| Kurum (test) | `7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4`; USDC hesabı (mint alıcısı) `4p2faFwmZTjkXua3wdHVrviqaLH3tuR3JdFcK82zXLeU` |
| Agent (test) | `C6iFdvJpk2bbFKTseNGhgdKuPZjWpV762b5wuW7AX1z4`, kayıt `52gxSYGG9vWeMmLLXST5fXddNdMToiZe1xzF1vKNr18V` (`bc36-cctp-devnet`, kartsız) |
| Screening | İki cüzdan OFAC SDN listesine karşı tarandı (yayın 10/05/2026, 19 363 kayıt), listede değiller. Screener authority temiz kaydetti; kaynak hash'i listenin SHA-256'sı `b61f54ea…5e72`. Kurum `221Mcokb…`, agent `c1UHunmN…` |
| Sepolia burn | `0x579e67589ff91e49ce72c499f01414a7c15d9f7dd6399d541f6bd988223c6911` (5 USDC, standart kesinlik, ücret 0) |
| Attestation nonce | `0xab4ef092ac8246464a4c1e2750038a96b4b5b1d2655a5198dc7e6548b3bec063` |
| `create_job` | `4UnXtueHmZFGi4Ac9dKHYq4juvP7fEL3sWZNEUceefDKrC8neMdiP32NjTNcxHzWtcehDSkSkDvP9LusLVqvRH6S` |
| `receive_message` + `fund_job` | `2qfMga78K7aTAx9ichvTyiMTeUEr3DzzJZNVB5nyNqpX5qe5q3nNeq5XQHyMdVEXooy6NfjYmZ13o1cmV3xg7rq2` (1 082 bayt, 202 865 CU) |
| Job | `DYog8N8bftM5cAY2xop7BzLjMmZqgW9wTAJek4LXbfGC`, `Funded`; vault `5HfGjn6fbSJoKo1oJnksH8Q2igtW8uf7cwsPdQGxwY3S`'de 5 000 000 |

## CCTP relayer (BE-26)

Relayer'ın uçtan uca koşusu, 2026-10-06 (`packages/cctp/test/devnet.e2e.test.ts`; [tasarım](../design/cctp-funding.md#relayer-be-26)).
Sepolia'da iki kez 1 USDC yakıldı (hızlı kesinlik, `maxFee` 100, alınan ücret 100); job'lar mint edilen tutarla
(999 900) açıldı. Kurum ve agent BC-36'dakilerdir; relayer cüzdanı deployer'dır. Burn'ler `registerCctpTransfer`'ın
mantığıyla kaydedildi (ikinci kayıt aynı transferi döndü); attestation'ı relayer izledi; veritabanı testin kendi
Postgres'iydi.

| Adım | A: kurumun tek tx'i | B: relayer'ın teslimi |
|---|---|---|
| Sepolia `approve` | `0x3a02d3ff1c0134eebc778c5f4ec9911b80729847a06f1f047d6c39c9499e86f6` | `0xe7fc673b461322c44dc046e1e71c375029c76b88e64ac99d7741bfe7ec79e1b2` |
| Sepolia `depositForBurn` | `0xde63214e295c4f916322b2ad042edc799069207c74a46e0f6aa637eebe36de7f` | `0x3b53e8385f0267b20191fb2a3dcc60b7ebbc41309a825dbd65b757f84cc7d122` |
| Attestation nonce | `0x39d2dc9019f609f0793bb9c790016aba7294770b697997ad8ff8fefe6cefab7f` | `0x450b04a0cf515f57f0467e76b3b4cde3693853d7f8f653e15407e5ba7c62c42b` |
| `create_job` | `vAnfQ2Fqp3LFPHsPeR4diYWCUpJhgi1eKtPhv1oQmAWUkb2wqvEh8n6qWhWVY4YdkHYEnBHgUcz6PW5bzn2UwkC` | `5zX2VBrCo1txUXtp1M41TodX1S6Dvndi1TLQAgouqzXSsQbg1P386ZNS12FFkCWiiNkqvCY69wFk8DKL3xpeYpAa` |
| `receive_message` | Kurumun tx'inde, `fund_job` ile (aşağıda) | Relayer: `3A18dF3u5Yg979qapN2jPU6qXkXPReC4xNmmaqFgGVGgqdxiA6ee4pVwZoyMTMSu2WKXMWZeJ92yGhqmEogHFKgZ` (940 bayt, yalnızca CCTP ALT'ı; 182 676 CU) |
| Yarıda kalan tur | — | Transfer `attested`'a geri alındı; relayer nonce hesabından teslimi gördü, tx göndermedi (relayer bakiyesi değişmedi), aynı imzayla `received` |
| Kurumun tx'i (`prepareCctpFundTx` mantığı) | `receiveAndFund`: `3kVtrhkqYKj7q4oRFwiufTtfKuwStDYZ7ZBicKXxQZdeHWwFesszrwaHS3XkdZLgnUxSEE3itHjvBpSN1nM5Ddr5` (1 094 bayt, iki ALT; 204 372 CU) | `fund`: `26bGXaaQ35wcUua75rT7rXFXyiUECwRrvYETiYYq2Qdx68a6y1n46doNpAtHWxjoKXdfzhD1YJ5UtydFBesbQm3m` (437 bayt, Square ALT'ı; 23 478 CU) |
| Job | `BjQ8W97SxsXpULU4RvUxVNdWVzR9331Yy53bm4qtWJAN`, `Funded`, vault'ta 999 900 | `9yEtKmbcz51i1KRoaUBXStaAksJzw1NXTKoeADkELVKJ`, `Funded`, vault'ta 999 900 |
| Transfer | `funded`; teslim ve fonlama imzası aynı tx | `funded`; teslim relayer'ın, fonlama kurumun tx'i |

Servislerin değerleri:

| Değişken | Değer |
|---|---|
| `API_CCTP_MESSAGE_TRANSMITTER`, `KEEPER_CCTP_MESSAGE_TRANSMITTER`, `SQUARE_CCTP_MESSAGE_TRANSMITTER` (web) | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| `API_CCTP_TOKEN_MESSENGER_MINTER`, `KEEPER_CCTP_TOKEN_MESSENGER_MINTER` | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| `API_CCTP_LOOKUP_TABLES`, `KEEPER_CCTP_LOOKUP_TABLES` | `0:2Zg2NRhkLqdFHq3SZcxqHmZkTTLXmKx4yeZNbfSqPbUY` |
| `KEEPER_CCTP_ATTESTATION_URL`, `SQUARE_CCTP_ATTESTATION_URL` (web) | `https://iris-api-sandbox.circle.com` |
| `SQUARE_CCTP_SOURCE_CHAIN_ID`, `SQUARE_CCTP_SOURCE_DOMAIN` (web, FE-19) | `11155111` (Sepolia), `0` |
| `SQUARE_CCTP_TOKEN_MESSENGER`, `SQUARE_CCTP_USDC` (web) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

## Screener (BE-16)

Screener'ın uçtan uca koşusu, 2026-10-06 (`apps/screener/test/devnet.e2e.test.ts`). OFAC'ın canlı listesi indirildi:
SHA-256 `b61f54ea…5e72`, 4 SOL adresi. Screener authority `48DGxja6…` deployer'dan 0.1 SOL aldı. Denetim kaydı
testin kendi Postgres'iydi.

| Adım | Cüzdan | Tx |
|---|---|---|
| Listedeki adres → `Flagged` (SDN uid 194570) | `42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi` | `4q9mdB83DVj5RqSvXgNJ1TykRTLpMCQTRoZLK5SjE3AYnH9evHR11TbaZ7m26gAKKRziXGyrmch48YFqDJnHtgmw` |
| Listede olmayan yeni cüzdan → `Clear` | `H5GBLjvy3B6mKqo6jmHGoxuxs1Nm87CgnFMpSTLvur6x` | `44FvHdGAdSaH5gfwvfwE4MqiWph1cNLM6XtYGEPyfqYwgKMkmVG24PmsGY6dLuedy4fiZktFWiyWuQFuRrFMY2NG` |
| Yenileme (`Flagged`, `expires_at` ileri) | `42RLPACw…` | `32M8xSmp75UtsncZzPJLGcy8YUzYi8TYJkHg33UGweo5qSsPZCNySMDw7iP4JcXLN7f7m3rGHM2ZQcNUznxMicdj` |
| Yenileme (`Clear`, `expires_at` ileri) | `H5GBLjvy…` | `3jug8pk42psPLuGi3qEa7v4GxaEvmZzzhDv6gyVxZfdtypCaNtUFjPR8UJjzQBPyJSq2y1gBKG54tceEcpHK3B57` |

Her kayıtta zincirdeki `source_hash` denetim kaydındakidir; `expires_at − screened_at` config'teki süredir (30 gün).

## x402 (BE-24)

Ücretli ucun uçtan uca koşusu, 2026-10-06 (`packages/x402/test/devnet.e2e.test.ts`).
- **Ödeme:** Fiyat 0,01 USDC (Circle devnet USDC'si `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).
- **Taraflar:** Ödeyen BC-36'nın kurumu (`7xNWRmEb…`), alıcı BC-36'nın agent'ı (`C6iFdvJp…`), ücret ödeyen deployer.
- **Hazırlık:** Alıcının USDC hesabı koşudan önce açıldı (`DZ4fUUgJvREe4W8dWy9ce1oJafBRmf4cDPE32yfAVaEpPsLDzRYmsEnYE3xyCxaAk5auiHQAzKf5XNp991puS2x`).
- **Depolar:** Tekrar koruması ve idempotent yanıt testin Postgres'iydi.

| Adım | Sonuç | Uzlaştırma tx'i |
|---|---|---|
| Ödeyen fetch: 402 → ödeme → 200 | Alıcının bakiyesi 10 000 arttı | `5CSPep7Qh4Nd7dFfMP9vvo96c1RFqumKEHuBfgaCNkYrgdm5KDxGixs17pwp6y9JdYqwSHFceGcYKo5es5wXUTRW` |
| Aynı başlık yeniden (yanıt kayboldu) | 200, aynı gövde ve makbuz; bakiye değişmedi | — |
| Kimliksiz aynı başlıkla eşzamanlı iki istek | Biri 200, diğeri 402 (`replay_rejected`) | `2MYysDru1hnH4jjvj7gdfL9135BKzhjoRqgSdg7ZmroHChXcPPcyvm9V8zCeizcxZedQJ4WBbspyxsHxg9Htr51W` |
| Uzlaşmış başlık yeniden | 402: facilitator'ın simülasyonu işlenmiş işlemi reddetti | — |

## Yükseltmeler

### Escrow v0.6.0: dispute (BC-32, BC-33), 2026-10-06

Program sözleşmesi v0.6.0. M-of-N arbitration, dispute zaman aşımı (`lapse_dispute`), ispatsız bekleme başvurusu
(`escalate_missing_proof`) ([ADR 0016](../decisions/0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md)).
Hesap düzeni değişmedi. Upgrade'den sonra config ve üç `Funded` job yeni kodla okundu.

| | |
|---|---|
| Kaynak | `feat/bc-32-33-dispute`, commit `93633b6` (programın kaynağı merge'te değişmedi) |
| Build | `solana-verify build`, imaj `solanafoundation/solana-verifiable-build:4.1.2` ([Deploy](#deploy-bc-30-2026-10-06)'taki digest), `--library-name square_escrow` |
| Executable hash | `84825b9b5f5e1087fc1a8e993f161d61a0dcd6760f49b99afa9182242ef2d796`. Buffer ve zincirdeki program aynı hash'i veriyor (`solana-verify get-buffer-hash`, `get-program-hash`) |
| Buffer | `AwH8mrwMFZ9ikUD5Ct4UrM2ZoebiuEvWZYGs6PDQYVvC`; yazan deployer, authority'si vault'a verildi; rent'i deployer'a döndü (spill) |
| Squads | İşlem 4. `scripts/deploy/upgrade-program.mjs` iki üyeyle yürüttü (muhammedakinci, mehmethayirli) |
| İmzalar | Oluşturma `2692LDVB…`; öneri `3fgWzDTD…`; onaylar `5BH5KDpJ…`, `21kCPyhn…`; yürütme `5o9LpXK7UK3Je3e9tS7Rojbv4t7hEyXTW372ZT9peFozmdcKhGLdCtiou99XQRXyu2DtxWmuLCLQ5KdD3QdWZV1C` |
| Son deploy slot'u | 508076228 → 508189090 |

Sonraki yükseltmeler runbook'un 6. adımıyla yapılır ve buraya eklenir.
