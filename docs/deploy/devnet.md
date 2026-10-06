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

## Deploy ve config'ler (BC-30)

Yapılmadı. Sıra: programların deploy'u, authority'nin vault'a devri, config'lerin vault imzasıyla kurulması,
Square ALT'ı (runbook adım 4–5).
