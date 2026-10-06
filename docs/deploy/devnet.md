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

## Sonraki yükseltme

Kh0ra'nın #184'ü (dispute talimatları, BC-32 ve BC-33) hesap düzenini değiştirmiyor; yalnızca talimat ekliyor.
Merge edilince runbook'un 6. adımıyla, buffer ve Squads "Upgrade program" işlemiyle yükseltilir. Bu kayda yeni
hash'ler eklenir.
