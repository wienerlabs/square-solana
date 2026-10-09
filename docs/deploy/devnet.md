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

Üye anahtarları devnet için üretildi ve sahiplerine verildi. Mainnet ortamı yok
([ADR 0027](../decisions/0027-yalnizca-devnet.md)).

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

Screener ve MPP authority anahtarları devnet için üretildi, secret store'dadır. Eşik ve süreler Square'in tek ağı
olan devnet içindir ([ADR 0027](../decisions/0027-yalnizca-devnet.md)).

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
| `API_CCTP_MESSAGE_TRANSMITTER`, `KEEPER_CCTP_MESSAGE_TRANSMITTER` | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` |
| `API_CCTP_TOKEN_MESSENGER_MINTER`, `KEEPER_CCTP_TOKEN_MESSENGER_MINTER` | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` |
| `API_CCTP_LOOKUP_TABLES`, `KEEPER_CCTP_LOOKUP_TABLES` | `0:2Zg2NRhkLqdFHq3SZcxqHmZkTTLXmKx4yeZNbfSqPbUY` |
| `KEEPER_CCTP_ATTESTATION_URL` | `https://iris-api-sandbox.circle.com` |

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

## Geliştirici portalı (FE-22)

Portalın API yüzeyiyle devnet koşusu, 2026-10-06 (`apps/api/test/x402-devnet.e2e.test.ts`).
- **Anahtar ve tanım:** Geliştirici (MuhammedAkinci'nin üye cüzdanı) oturumla `x402:serve` kapsamlı bir API anahtarı oluşturdu ve
  0,01 USDC'lik bir uç nokta tanımı açtı.
- **Sunucu:** Geliştiricinin sunucusu tanımı bu anahtarla okudu (`paidRouteFromDefinition`). Ödeyen BC-36'nın kurumu,
  alıcı agent'ı, ücret ödeyen deployer'dı.
- **Uzlaştırma ve kullanım:** Uzlaştırma tx'i `4SqCKJnC8Ui9umWWFrRHpUwZMUY8x4xvH6pLhPG9ayxJur42ugYiXtPLktXYnFPkgKNcCPNsHTw8QCFX3hTPJ8yG`.
  Kullanım: 1 ödeme, 10 000.
- **Kapatma:** Pasifleştirilen tanım 503, silinen 404 döndü; iptal edilen anahtar tanımı okuyamadı.

## Fee payer ve Squads smart account (BE-27)

Uçtan uca koşu, 2026-10-06 (`apps/fee-payer/test/squads-devnet.e2e.test.ts`).
- **Smart account'lar:** Kurum, agent ve alıcı rolleri gerçek Squads v4 smart account'larının vault'larıdır. Her
  birinin tek üyesi ve eşiği 1'dir.
- **Sponsor:** Fee payer servisi (testin Postgres'iyle). Sponsor deployer'dır; 22 tx'in ücretini ve rent'ini o
  ödedi. Vault'lar hiç SOL tutmadı.
- **Kurulum (sponsorsuz):**
  - BC-36'nın kurumu vault'ların USDC hesaplarını açtı ve doldurdu.
  - Screener authority vault'ları temiz kaydetti.
- **İspat:** Zincirden kurulan witness'la üretilen gerçek Groth16 ispatı.
- **Ödeme:** İş 1 USDC; alacak 0,9 USDC'ye alıcı vault'una satıldı. Finalize'da alıcı vault'una net 995 000 gitti,
  keeper'a 5 000 (50 bps).

| Adım | Tx (yürütme; öneri tx'leri test raporunda) |
|---|---|
| Smart account'lar (`multisig_create_v2`) | `5XX214pW9iY7Cv4e7h9G5x1vvWBgcJNvBxS53MNY5DUtp4qDvBwa9nv3qUpano5aq92jSqsNYf7WfSpVfcwDjmv3`, `3tGx9LjQ11Vi574wsh9qUXKgqxZorARu3J1nvT23J6nwvyrPCp3bQ3eahYXxydeuoGTJP17yFKXcGGfpmCaz95ro`, `3D1QpkJBNnbtfQWwtDNFRkLc46iUqgFspyDTcQ3aQDR7MgVKqB9Y1nTkwCpKxUEJRzi16GsovnZCrFme8vRrrnnA` |
| 1. `init_institution` + `set_policy` + `set_buyer_root` | `4TxZvqidcpW24EZeiLNuz8WhYj5RnmDYeQPbSs957BBy3aN2pfsRfRWVvP161hE1UQ5ra5HejnTiEdRoZqEASkZc` |
| 2. `register_agent` | `5t16zTqhEzRdMs4sHpBhvbrxwAD2gehKPR8v46bMvytwFByHFSv52HA2da6gN6ncce5t7fo4RWVLYtYEeugX5QVP` |
| 3. `create_job` | `5H1WxNAqYtwTDGiFdJYk3SQDteikunYQvs7ecjPiUoBv6YPNNtgbeMNpNFsu5eyXaN5kM13hTBWGCM1YkAczXDGS` |
| 3. `fund_job` | `RckLucP1g3YQwNZ7tiqXTsAYEj8kpk4PBD12efh2LSNQBMgGXDSBMKhvozqYk2oT4Et6X9gXvrxioQz4X7ZyzRT` |
| 4. `accept_job` | `RR1t9Ah4cvekFiZDKfM5gL6u16godCMtwu45qo7a1TZ56ZDYuX6sULYRhfZifHQg7ZcEYRPwZKw8KwrV2AeoZKQ` |
| 4. `submit_work` | `4QWM8p3QSzMRMgSg99XKYMtPYpSxC5Ykhxoz3k5BBfsb4x4rr6sY4LzpcCFbHz443CCGcQ5UFjqDqm6hBrCqaaAM` |
| 5. `list_claim` | `2cccN6GWgBQnfBV831Q7zFvHcA3HT3X3rpmA1kWRwmVm2Cq4a6Z4SNxoCG4zGx9JYNrnf9brWTtxiZFSJp3J7fAX` |
| 5. `buy_claim` | `5N2dj7eNnJdbZxKUbQDnfkCmn1x4dnPUCgMVgVSe8oZusQgVVW4CvNzrE8YYgC1gq6EwzgjkzPDeNY45jYtJv7Am` |
| 7. `set_compliance_proof` | `5Lk7VtSaQ9cvdeTs5E6S6hKLvJmU6ABdDyTaXrzn5hde6apCikpmtCwt6h2tJ2r91kD4h1bzryvFuALP6Ny4C6Mi` |
| 8. `finalize_payment` (keeper, sponsorlu) | `3duiU4XxhReQqTMMabuxx6FkCMMLy1z7BdikRcpntM9X9DKeyBY3AWf4pv8oTfo5gsTeSu9msXVqWmAUdBad8v5y` |

CU ve boyut ölçümleri: [tx-budget.md §8](../design/tx-budget.md#8-sponsorlu-tx-ve-squads-vaultu).

## Uyuşmazlık (BE-22)

Uçtan uca koşu, 2026-10-06 (`apps/api/test/devnet.e2e.test.ts`).
- **Taraflar:** Kurum ve agent BC-36'nınkiler (`7xNWRmEb…`, kayıt `52gxSYGG…`). Arbitrator'lar escrow config'indeki
  üç üye cüzdanıdır, eşik 2.
- **Indexer:** Gerçek süreç olarak devnet'i indexledi (testin Postgres'i). API kanıtı, kuyruğu ve oy tx'lerini bu
  aynadan sundu.
- **İş ve bond:** İş 1 USDC; bond config'in en azı, 1 USDC.

| Adım | Tx |
|---|---|
| `create_job` | `5J2A3o4DwwSeAHr98M4JJPjYMp5hsy3hqmiy8bha62f4QtwYQemiLXYLQyuS7WZG486tCvFFJzkBSm5vQqWTiFo4` |
| `fund_job` | `2bSTXGBGXDYbBvFvmJvutSrNDdNf1s35rq27nL3Spm9y9rMLBSfERTz17gw5kaNEvYt24Jkw1fM1PSFVePQ3268S` |
| `accept_job` | `QJY9p1uu9VDZDiqsFt1Rx7AKFzwqzdLbVRjD1PoNC74dwhkJ3c9Rp3kZv9YMedvU6L57uBwz6Ng3D7ioHSEHPEK` |
| `submit_work` | `LoKZZ3dcY4LtMtTAFJQCpqPeyj38JG8uaZLe9V3D7DtB6RdZfT8Vantu6f2NHZUXdREXKqmHijeRydmzArrofv8` |
| Kanıt (`POST /v1/jobs/{job}/dispute/evidence`) → `raise_dispute` (reasonHash = kanıtın SHA-256'sı) | `3Y4tcWkLiakoHawqfP41hzand3bDoFTvSMMeFjTckYkTXj8fqP9hFVfopG2kKdxFtwnViKd98AYaMgZrFBSdJfWP` |
| Oy 1 (`DPF8Myr3…`, API'nin hazırladığı `resolve_dispute`) | `1WyxdLTvZZxi6cxREccwQdoySPuRNiPVJ3VW6YwDgSF6NgRiQSm7rwhDoY4jEud37jqssn6iJxvxus1E9fMvDY` |
| Oy 2 (`EZggdp7B…`); karar `FavorAgent`. Üçüncü oy API'de 409 | `5cD3kPHB4x2gj3ntFp4W4RgD8XuSvdJ6j3x25eA7McuC11MYNEs3mLhNFovUATrfHJ3tH5KxZguFfr1742o9saMA` |
| `execute_resolution`: 1 USDC iş + 1 USDC bond agent'a | `4gsD7uozs5TPaYtCG53rwB62X6D4DEh9ceZfEt9rmr13gzWDTquCfeFpy1MxhEbM36vTnNxxyHxv3W8GQVDss34Z` |

Lapse (dispute son tarihi devnet'te 7 gün) localnet testinde gerçek keeper süreciyle gösterilir
(`apps/api/test/localnet.e2e.test.ts`).

## Smoke (BC-31)

8 adım ve iki varyant (ispat-ret, ispat-yok) gerçek işlemlerle, 2026-10-06: [smoke-devnet.md](smoke-devnet.md)
(`tests/smoke`). Kurum ve agent BC-36'nınkiler; alıcı `H19475gy…` ve keeper `GCKxtmGg…` koşu için üretildi, kurum
alıcıya 1 USDC, deployer keeper'a 0,1 SOL gönderdi.

## CLI (BE-30)

8 adım `squaresdk-solana` komutlarıyla, 2026-10-06: [cli-devnet.md](cli-devnet.md). Kurum, agent, alıcı ve keeper
smoke'unkiler; ücretleri deployer ödedi, ispatı yerelde çalışan prover servisi üretti.

## Fiat ödeme (BE-25)

Stripe test modunda ödeme → MPP attestation'ı → `verify_mpp_payment_proof` → `finalize_fiat_payment`, 2026-10-07:
[fiat-devnet.md](fiat-devnet.md). Job `4jFcA9uD…` `Released`; MPP authority config'teki `CPwxS6VA…`.

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

### Verifier ve escrow v0.7.0: Stripe MPP fiat rayı (BC-37), 2026-10-07

Program sözleşmesi v0.7.0 ([ADR 0024](../decisions/0024-stripe-mpp-fiat-rayi.md)):
- verifier'a `verify_mpp_payment_proof` ve `update_mpp_authority` eklendi;
- escrow'a fiat iş (`create_fiat_job`, `cancel_fiat_job`, `finalize_fiat_payment`) ve `Job.rail` eklendi.

`Job.rail` hesabın sonuna eklendi. Upgrade'den sonra config'ler ve 15 job yeni IDL'le okundu: 6 `Released`,
3 `Refunded`, 3 `Delivered`, 3 `Funded`. Hepsinin rayı `Escrow`.

`VerifierConfig.mpp_authority` değişmedi (`CPwxS6VA…`). Rotasyon program upgrade'i gerektirmez:
`scripts/deploy/rotate-mpp-authority.mjs` ([runbook](../runbooks/upgrade.md) §7).

| | Verifier | Escrow |
|---|---|---|
| Kaynak | `feat/bc-37-mpp-fiat`, commit `0dcb71e` | aynı |
| Build | `solana-verify build`, imaj `solanafoundation/solana-verifiable-build:4.1.2` ([Deploy](#deploy-bc-30-2026-10-06)'taki digest), `--library-name square_verifier` | `--library-name square_escrow` |
| Executable hash (buffer ve zincir) | `d7ec6985f645ad7eb57faf98d8c559bb5f9e0602e22d464e8389405a47faab52` | `10ede5234f421c2dcb109cb4a04466b82db36d6b5999ef44d4bbcdc5c8825e16` |
| Buffer | `7SCDKESj4fxWAX5YttSsoouy2dbuUhRRuSdoW2Pw2dan` | `DkykjNMr9pyw53CTwvMR9FP4i7XUegad6baq3rjqEb27` |
| Squads işlemi | 5 | 6 |
| Oluşturma / öneri | `4NpLHRKg…` / `4T1SAE6c…` | `4ueBc5bC…` / `4myYXdB9…` |
| Onaylar (muhammedakinci, mehmethayirli) | `3DimM3Qe…`, `615DFZPC…` | `3Hn6KVJk…`, `HJez1y7H…` |
| Yürütme | `2kMs1EhVWCnLGuqFb2Ki2GLPqYiz9BzqLDhvxjBRKiUwyn6dB5mt1Tapon1w1jfqjfo5yXBS9p9PY8911BU6HwQ4` | `27a6zHtvrRccZncCeZvPcVSdGCAM1f5AQda1Uu1zXVgq5HDQUc4ydFhCCZEUn4X48X8UqdzevmPqb1rMsscxfXEP` |
| Son deploy slot'u | 508076174 → 508252508 | 508189090 → 508253095 |

Buffer'lar `upgrade-program.mjs` ile yazıldı; authority'leri vault'a verildi, rent'leri deployer'a döndü (spill).

### Verifier ve escrow v0.9.0: P-07, P-20, kabul öncesi ön-ispat, ret oyu (#265, #262, #259), 2026-10-09

Program sözleşmesi v0.7.0'dan v0.9.0'a tek upgrade'le:
- **v0.7.1** (#265): `escalate_missing_proof` neti ya da mint'i tutmayan ispatı işi kapatabilir saymaz (P-07); verifier
  sıfır `mpp_authority`'yi açıkça reddeder (P-20).
- **v0.8.0** (#262): verifier `set_preflight_proof` ve `PreflightProof`; escrow `accept_job` policy'li işte ön-ispat
  ister, `create_job` / `create_fiat_job` public tavanı aşan tutarı reddeder
  ([ADR 0028](../decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md) madde 1–2).
- **v0.9.0** (#259): `resolve_dispute`'ta ret oyu ve önerinin sıfırlanması, `Job.dispute_rejection_mask`, agent payı 0
  iken `Flagged` payee'nin bond'u kuruma döner (ADR 0028 madde 3–4).

`Job.dispute_rejection_mask` hesabın sonuna eklendi. Upgrade'den önce ve sonra devnet'teki 19 job salt okunur tarandı:
`rail`'den sonraki baytlar sıfır, yeni IDL'le hepsinin ret maskesi 0 (9 `Released`, 3 `Refunded`, 4 `Delivered`,
3 `Funded`). Verifier ve escrow config'leri değişmedi.

| | Verifier | Escrow |
|---|---|---|
| Kaynak | `feat/259-dispute-bond-reject`, commit `9f464b1` (main `d4ccea8` dahil) | aynı |
| Build | `solana-verify build`, imaj `solanafoundation/solana-verifiable-build:4.1.2` ([Deploy](#deploy-bc-30-2026-10-06)'taki digest), `--library-name square_verifier` | `--library-name square_escrow` |
| Executable hash (buffer ve zincir) | `4eaa720461ac17050aba253ea4d4b6b3686e1e6a779665284039b54236b028bf` | `3d69668fd705133e8d562f531ded285ab99862f943b1a95cddbe651bdcd2c78c` |
| Buffer | `FJMNoVnDF2qdghnkhWY4EumQRmFwg5zvfdV2ZmQDNJeq` | `GFeXqPkJ2AkYMjaPGmY6f2pr9fMsGMgXpDeczhuJ4yxL` |
| Squads işlemi | 7 | 8 |
| Oluşturma / öneri | `34zmX1Md…` / `2asNdaro…` | `34WPHqjE…` / `5KjmQgA1…` |
| Onaylar (muhammedakinci, mehmethayirli) | `Ry3NGAyw…`, `4g8ZGTpZ…` | `2r7nmcNm…`, `Zu2yMZZv…` |
| Yürütme | `56ST6TUZqU1ckZTemDBY9RoBtTEbUcUMZMJnLGthRNPjET82WT1LdzdkUNpKtKg8apHDKK6E7R6TXBHAkAQob1th` | `5Xk8nWtEGmYGpoA58FneQ14Azh8CVZ4fAY8TrgpGQEGjDbYuGsu5zhwS2TeVSnNr56XHtWiSt8eGpgbCHYArRH3g` |
| Son deploy slot'u | 508252508 → 509128797 | 508253095 → 509128841 |

Buffer'ları deployer yazdı, authority'leri vault'a verildi, rent'leri deployer'a döndü (spill). Verifier önce yükseltildi:
escrow'un `accept_job`'u verifier'ın `PreflightProof` hesabını okur.

**Ret oyu, devnet** (`apps/api/test/devnet.e2e.test.ts`, 2026-10-09): Taraflar ve indexer
[Uyuşmazlık](#uyuşmazlık-be-22) bölümündeki gibi; iş `F4vKZ88ffyWBeD28ZRffMtYEeAVHmrCiz4hR2Pu8AEXH`, 1 USDC, bond 1 USDC.
Arbitrator'lar escrow config'indeki üç üye, eşik 2.

| Adım | Tx |
|---|---|
| `create_job` → `fund_job` → `accept_job` → `submit_work` | `58gt2pN8…`, `65UDLcQY…`, `2oxTtmSs…`, `3gCAo1ya…` |
| Kanıt → `raise_dispute` | `62zNtdCmuhrXjeNnPsgFKyv3j9a54xj5y6DRb8msmR8AzFJ9FKi8tMpQucqZZKrvxXKCaYwzP8PKQLhCm1FdTKe9` |
| Öneri: `DPF8Myr3…` FavorAgent | `4DXt9922cHELbPm8MnULKAcFHsqGL8YCSEaLssJ7M9DxcvTGy27WCp1T1FQyKEUWuDxWBEnv5HfMLm85qNAP4b7q` |
| Ret 1: `EZggdp7B…` FavorInstitution (`DisputeVoteRejected`, sayı 1) | `5PDdPt5n63uDwefNV2Bqw3wVRSEzz1C5gyut96KUd8SZePvU8VREnn5D2aC1B34RD5Dzt5UZXpTuKufnGwZxFBTa` |
| Ret 2: `4DepaL4D…` FavorInstitution; eşik ulaşılamaz, öneri ve maskeler sıfırlandı | `aGwMPVxaWBeQqPoEkLzHQrSiQw4XdjvDZeU2yjpKmJzXw5vBe5LeE1sCY51s7GibPfAmB8BgtgmjnDKzGFUZPhn` |
| Yeni öneri: `EZggdp7B…` FavorInstitution | `6oiTEKnPXBMabuuKrihvGq3ZJ4LkmrnaNYqPTnE2pfJsRJvd62JUXPkod7ikR6VdfjaEYfGfYCZ18KXQ6eBaVLV` |
| Eşik: `4DepaL4D…`; karar FavorInstitution. Kararlı dispute'ta oy API'de 409 | `5cVN7KgMiiea323JxgEyftrNu7BaCuMXnYuMsXbfXsgXVUL6sVJ9SzAS1U1kcz9mrxL3nMrsd5vwJHYkQMFQU5Vq` |
| `execute_resolution`: 1 USDC iş + 1 USDC bond kuruma | `4ip9dK5mjU2fi1QVzj4R26uDmS1NpCQQsyCYhA4qjSSogBsgpSF2qWKDiB7TX5szZxzQEnHTNcFWtR4RDRAeY7LM` |

Indexer altı event'i (öneri, iki ret, yeni önerinin iki onayı, karar) ve kapanışı aynaya yazdı; aynada
iş `refunded`, ret maskesi 0.

Sonraki yükseltmeler runbook'un 6. adımıyla yapılır ve buraya eklenir.
