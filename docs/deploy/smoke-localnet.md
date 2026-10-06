# Smoke raporu: localnet

> **Küme: localnet.** `solana-test-validator` (Agave 4.1.2) üzerinde, `smoke:localnet` koşucusunun açtığı geçici bir zincirde gerçek işlemler. **Devnet raporu değildir**: devnet kaydı gerçek deploy ve smoke'la `docs/deploy/devnet.md` ve `docs/deploy/smoke-devnet.md`'de oluşur (BC-30, BC-31).
> Programlar `target/deploy/*.so`'dan `--upgradeable-program` ile yüklendi; zincirdeki executable hash'leri `.so` dosyalarınınkiyle aynı. Upgrade authority, rol anahtarları ve mint (6 ondalık) koşu için üretildi ve koşu bitince silindi; imzalar yalnızca o zincirde geçerlidir.

**Issue:** BC-31 (#43) · **Üreten:** [`tests/smoke`](../../tests/smoke/)

| Alan | Değer |
| --- | --- |
| Küme | localnet |
| RPC | `127.0.0.1:48899` |
| Başlangıç (UTC) | 2026-10-06T22:37:43Z |
| Bitiş (UTC) | 2026-10-06T22:38:15Z |
| Commit | `fa0cdd5645054f3c54fe6b676365ddff58f99564` |
| Koşu | `20261006223743-2e62` |
| Program kimlikleri | registry `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9`, policy `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4`, verifier `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh`, escrow `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |
| Settlement mint | `EZRZsN63hsuemjnwxXi1krZUoqt4QsZmsXEe4fYUrSNL` (6 ondalık) |
| Square ALT | `AbSvgtbGGXTye7epP1if6Qq7n1VabvPDWpcC7zQcLYSa` |
| İş tutarı | 25 000 000 (25.000000) |
| Alacak fiyatı | 24 000 000 (24.000000) |
| Keeper ücreti | 50 bps → 125 000 (0.125000) |
| Challenge süresi | 5 s |
| Öncelik ücreti | 1000 micro-lamport / CU |

## Roller

| Rol | Adres |
| --- | --- |
| payer (ücret, rent) | `ECM9E43VhACtBgPQmNPATNAXccYBzciKHH3ytAwhPZVm` |
| screener authority | `5Nsv3twSyjNCNDUnTwSiexeuiYUE9Beogwyd3fSiankg` |
| kurum (imzacı cüzdan) | `4uFEDQuTJaGnqoRdkjHyzngJZjcTUDt4Qhj2XQbiQvyF` |
| kurum (`Institution` PDA) | `14bjtBHfEgWvJc5jkdEixhopjXwQj3vjfiF1F7UzdsTj` |
| agent (sahip ve cüzdan) | `7LqinxTnB2wapcon4VD1G63EEwQCfWZfEJJGdWkfxKo8` |
| alıcı | `7N8wLvtbNB8LSAQ4P4vvgYiyNaC195v8SyzDpoKRspQw` |
| keeper | `5NhqrGMAbavgXDnE1HUVHqEbjRQLKGe4HPBFwR92C5ZN` |

## Özet

| Bölüm | Tx | CU | Ücret (lamport) |
| --- | --- | --- | --- |
| Hazırlık | 1 | 16 668 | 5 203 |
| 8 adım | 13 | 462 880 | 126 390 |
| Varyant: ispat-ret (kesin ret → iade) | 7 | 340 031 | 65 930 |
| Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir) | 7 | 378 308 | 61 090 |
| Varyant: fiat (Stripe MPP attestation, BC-37) | 7 | 283 023 | 70 996 |
| **Toplam** | 35 | 1 480 910 | 329 609 |

## Hazırlık

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | keeper'ın ATA'sı (idempotent) | `391ks6ovCurhZg4GaevFs6gqF79i5baYWv3gJ2CaJbsi4eAbZDLeHqdi5K4EuxfvYmmrj7yRidthGCP9pznxCycu` | 16 668 | varsayılan | 5 203 | 323 | başarılı |

## 8 adım

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `initInstitution` + `setPolicy` + `setBuyerRoot` | `4tmpbTANkCjNzfP6uP9UzYsqXmoLURV5yHoVora7BdwL8D2KwH2T53QewCPxuKp4BbBiQ6vJrtJYT7DqP2A6NfKX` | 31 846 | 130 000 | 10 130 | 587 | başarılı |
| 2 | `registerAgent` | `AxNUpU2p7pNNJse5YpRgHahrTj5vZ4t7jCodFUWjqREA1ow1sJ9cp1iRCq41SDbQT71fGKbpxQp71ibrg4383sH` | 10 793 | 40 000 | 10 040 | 495 | başarılı |
| 3 | `recordScreening` (kurum) | `5yZXxNhenKCgjYiTUDvymULtBv7khVRU8Qp4fMHWKok6tN2jiMr3SMG8sXhmKQ8ed8fQzPVrVrSpQxfEyE1cspdC` | 10 554 | 60 000 | 10 060 | 465 | başarılı |
| 3 | `recordScreening` (agent) | `3LqS4ZRt4Xdex676tfYT3r276U5eHAfjpKPCG49HwvQnw8t2BcTywwF8jRjZ4jYmJEYBrEm69wyTrEyTq8CQn3ow` | 15 054 | 60 000 | 10 060 | 465 | başarılı |
| 3 | `recordScreening` (alıcı) | `65hFSQ1oFTZfyxG3Lj1FtcJUAfXW8a9ZPsr9nVTJtf2ts4h7vWMBG5Cab1Ce2fLYQSnorhxNFS78wTiFwHDcnHcd` | 10 554 | 60 000 | 10 060 | 465 | başarılı |
| 3 | `createJob` (politikalı) | `4aVbzoybvyiC6e3uTRmoPtRmrub7YQWK51dDZVSGqrrwtV4Er5gTdvhaWKvy2yt2p8otkne9VuKieen76DTUixwz` | 31 322 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `5V2fJwvqkx9h4fZAS44zzstVzzwGDpdAr4ztJHtMzN9jxydXiREvKjyCmXVQxs88EQidT6mA2kCDJJZEc37urabD` | 32 608 | 120 000 | 10 120 | 533 | başarılı |
| 4 | `acceptJob` | `41C9uJrzfQJcWkTcWPKwkJFs1cqgVNuBg4xQYDgdqbxeAR7VyiiZyzk1oJ68cqjWyi3M8tKYtZVoPxmf8eJpxRfb` | 7 891 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `5A9u4MJKRovC3ivPkoZtA6CUX7JK3VMvKtqwzJLJibUoqqvGCN9V5nAcenjBoc2gbuVjQc2583HwYBtyWaPLjzk2` | 8 448 | 20 000 | 10 020 | 477 | başarılı |
| 5 | `listClaim` | `4D1GUyifhicpoMs8BSjcm9cA7EBdrFc39Yauwug2QrCAMVgnTjQmL5Pxg6zPACX1fgrm7x3cZqezkcwhFpy6Vmny` | 11 392 | 50 000 | 10 050 | 439 | başarılı |
| 5 | `buyClaim` (Merkle kanıtlı) | `ykeq2JaqNSH2h5QHKMWcG8wqXTzU9ZSMUzusVrfydPtp8cgHRdaFjLBtoGN252k7LqShmAffqvzSE5cmw1waGSx` | 34 355 | 120 000 | 10 120 | 685 | başarılı |
| 7 | `setComplianceProof` (Groth16) | `vZGqb1kJrjKWFfGKRPX2AhghtqsiTkMWs9HAgXz36MHLLuUHBBR8o8ajFNZrHaRpfTfMGAUenZ42tYR92UKuazV` | 178 369 | 390 000 | 10 390 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `2hLePA38kRRLR8U8YaFTzkcfN6JZ1g6cHXFQBrYJKbUNyNZmaDZSFeMtrYhVL293VKQ986PXgb9LnYiNYjtAmcyX` | 79 694 | 220 000 | 5 220 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `BVm5ENzTv1DMDVVLXxVxyrjm6f64qeXLuzkSdpmpu1my` | compliant | 0 | 906 |

Zincirden doğrulananlar:

- `Policy` 9C5PF5WpFimpRcmnBygFNph3vsW5ywNAF8AoWERMRZA2: commitment yerel politikayla aynı, public tavan 25 000 000 000, sürüm 1, aktif
- alıcı kökü 3539e7c1ea5f70187e8290152d54121d67e72e020b65c0a617778ff5abe74527 (1 onaylı alıcı)
- `AgentRecord` 6zYGZSGk37W45VE2ZfmdfEUxYziNjTihx4sJCTznbtSy (`smoke-20261006223743-2e62`): cüzdan agent, durum aktif
- kurum screening'i temiz; geçerlilik sonu 2026-10-07T22:37:44Z
- agent screening'i temiz; geçerlilik sonu 2026-10-07T22:37:45Z
- alıcı screening'i temiz; geçerlilik sonu 2026-10-07T22:37:45Z
- job BVm5ENzTv1DMDVVLXxVxyrjm6f64qeXLuzkSdpmpu1my fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T22:37:52Z
- alacak alıcıya satıldı; payee artık alıcı
- agent fiyatı aldı: 24 000 000 (24.000000)
- `ReleaseProof`: uyumlu, payee alıcı, net 24 875 000 (24.875000)
- job `Released`
- alıcıya ödendi: 24 875 000 (24.875000)
- keeper ücreti: 125 000 (0.125000) (50 bps)
- itibar (`AgentReputation`): tamamlanan iş 1, kazanç +24 875 000 (24.875000)
- `ValidationRecord`: `Verified`, ispata bağlı
- alacak listelemesi `Settled`
- `ReleaseProof` tüketildi (`record_release` CPI)

## Varyant: ispat-ret (kesin ret → iade)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `setPolicy` (işlem başı tavan 1) | `4nVKMk3bwFwKZi2fC2hUKuvY5qqP8mV41uadGcka4NmRWnJRYCy5LDz8bFEXYyqgZM8GsupjeHEVDZQKBSVxhK1J` | 11 293 | 60 000 | 10 060 | 503 | başarılı |
| 3 | `createJob` (politikalı) | `2nyXcBheFyvrEG1k9G9AoYxeqFmhrPqL1QCJ5UvthAFsVMiRjzRbcBri8U1Sbd11qcvDCkpBiFwtRXn8FEjXbcVD` | 29 822 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `5ELLusPTU4rcTCHjciMG2H4o889cmVf4vtATV8chaTU8pGY1LdkGYN25NqfuJWombxic1vEcjFgFs69TfSN5bAyj` | 32 608 | 120 000 | 10 120 | 533 | başarılı |
| 4 | `acceptJob` | `4bsqPKSuz25SQ8gxKqXS2hpA5mvWdSivgQbiNJxfmqdBYabVa7i5Rm6bjsCo6KurwzjTrmyKHEfXPKYoWaU5kMGs` | 7 891 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `31shhPwy7xxywDX7dCzsfPDKWNfPejvyYuewKs2W7K8DD7dKTS1CXpvpbUWyA6ymmc8wNKRU5KQ1abtizskVtgz4` | 8 403 | 20 000 | 10 020 | 476 | başarılı |
| 7 | `setComplianceProof` (Groth16) | `5mSNtL8Ngj5cmceqtud55RwBmu3Za5UKMy33hanxcrtjpSLew5n18E6U1CJcVritX4EpkujhxiHPq2LPL4XLGenR` | 176 955 | 390 000 | 10 390 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `5CzX24jZh8yrp2ZiNJJnt7hYsmm4TVA1SBgUNf1EdJEUQd4qkprqwACYk7Uok7xv1vZEgs5wjv2s1gnBatWJ5BaL` | 73 059 | 220 000 | 5 220 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `59bfbqjvwyGPXb2S85Gs3xkdPQhisHuRTSGdmFcjheD7` | refused | 1 | 836 |

Zincirden doğrulananlar:

- `Policy` AZWgfrqqA8g1YG76Cbp5BMqq75b58yL8FNZmzFHn8gb3: commitment yerel politikayla aynı, public tavan 25 000 000 000, sürüm 1, aktif
- job 59bfbqjvwyGPXb2S85Gs3xkdPQhisHuRTSGdmFcjheD7 fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T22:38:00Z
- `ReleaseProof`: ret, kod 1 (perTx), kesin ret
- job `Refunded`
- net kuruma iade edildi: 24 875 000 (24.875000)
- keeper ücreti yine ödendi: 125 000 (0.125000)
- `ValidationRecord`: `Refused`, ret kodu 1
- itibar: tamamlanan iş ve kazanç değişmedi

## Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | `createJob` (politikalı) | `62AZoSvnkzgrpvbf2ripsj2LsqcczqLukdyNRSaYggdfLLeQHdv7xqP33smVYZvpbRwReugpbh7q8UfyRVQ7Eq7k` | 29 822 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `B3mJtBxDG23SSSUGiYyMqiCgGAAmJoqjdmWwefSHpzpMKHVvCuRvt7rqrWJ5wZXYtLbEgSmJMx4zLFmBrABsgn3` | 32 608 | 120 000 | 10 120 | 533 | başarılı |
| 4 | `acceptJob` | `4PXqxPap1TRXMcdAzvV1KttWudqWVDb99NSRxo5dHv5mFVCEYm4qEQXAPjpEwRNSkSnuuYXx15BiVbi17asz9EgB` | 7 891 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `46fBwmQUfjYQVbvncWh6af9fPq9xYPgc8FzN3aqYQDBHtwx3B4CxpFsxA5kR18PGHjJQvhcFgK7icZerRxRXsmQn` | 8 403 | 20 000 | 10 020 | 476 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `2ZM1FkCkVkoEFAAPEKwpxhEVBxN7iXL77FYgcve3baLxuJwNuMCC6xk8jNodWUa1UagNbWoxTdmGYRbFtM93dq4` | 46 230 | 220 000 | 5 220 | 792 | beklenen ret: `escrow::proofRequired` (6039) |
| 7 | `setComplianceProof` (Groth16) | `BBEeU7tSQkuYirGvLSbtQzQrT9ngTCDGK9wSyc1Gc5vmUCU5asuPZbWZVYHSXGD9SZfoTNBTKFq9dD3rva8r8jA` | 175 452 | 390 000 | 10 390 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `4kfgVxuDKBjZd5sXdF6ujr8zWK3zzfhy6ssDMTovEpQ6cF8Z3hqGkZQ23GpGDg3Mj1hGt9dpm5jYbW3kWSpFLmHy` | 77 902 | 220 000 | 5 220 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `Ay2RnoqRuMZ9F8WZdLnCqYfVbXt18U9KJzUjxFNtxd7t` | compliant | 0 | 910 |

Zincirden doğrulananlar:

- job Ay2RnoqRuMZ9F8WZdLnCqYfVbXt18U9KJzUjxFNtxd7t fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T22:38:07Z
- finalize `ProofRequired` ile düştü: job `Delivered`, vault 25 000 000 (25.000000) (escrow bekliyor)
- `ReleaseProof` hesabı yok
- `ReleaseProof`: uyumlu, payee agent (alacak satılmadı)
- ispat bağlandıktan sonra job `Released`
- agent'a ödendi: 24 875 000 (24.875000)

## Varyant: fiat (Stripe MPP attestation, BC-37)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | `createFiatJob` | `5oRT3FammJbR6DTrrTcYp3MiKRC2KQFxPsQDULyM9cQJYhRV9rLXyNxsP8JEbwCeQsJQoxov6Q1cxzNrF8p27WkR` | 35 949 | 70 000 | 10 070 | 613 | başarılı |
| 4 | `acceptJob` (fiat, açıkken) | `3LT5r7UPkmw76x4MPMw5ndVwZeUHgKjEYJZqupXcUcu8kXTUGDRt9nVHgaVLtSYqDWej5xAANR79gw9Cz7P9czR` | 7 889 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `pBa2JMLmVTk6QBmgDAD9gMAdLFWjY5N53JtzR964gbACsRFAUy7zhUd9pMwfZLD9cUu8HZAJ7Py9P5A9FyFdbAy` | 8 327 | 20 000 | 10 020 | 471 | başarılı |
| MPP | `updateMppAuthority` (yeni anahtar) | `cTcLgpD4UwexymSGEMUUKaVBSeGfoR9AiWdd6g3YKyYhJUq74iNuKBnn4efEnWEhqj7Udgw7c2fSwAtQEtWLc8W` | 4 433 | varsayılan | 10 203 | 388 | başarılı |
| 7 | `verifyMppPaymentProof` (Ed25519 attestation + Groth16) | `3ZSQKhw4uXWVBkgABDRqg2S28RLzayg8jZ2qYCkUhCaVFfSCqK53chPKWAEyynTSRaarFgLVrG1mvQBcSdrJwQKV` | 174 780 | 360 000 | 15 360 | 1076 | başarılı |
| 6 + 8 | `finalizeFiatPayment` | `3iDxbsQYo3FhdaEaMDNvXEpdWj1CYXfVbUMnUNAQomQ1vcM7422BApWDKUq3mXyXQFsiCi8szqMbhFFzBL3bGdRB` | 47 212 | 120 000 | 5 120 | 441 | başarılı |
| MPP | `updateMppAuthority` (eski anahtara geri) | `5ntQFwpGb1aGniQ2UT8RpbJut5cDhMKVdAb6HgWVU8pMRZhdbyC81pxFdhrKqNVR8iCjToxZ9oy8nRdTjCMsSwPp` | 4 433 | varsayılan | 10 203 | 388 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `6QNeRLuyPt9ZtdcuaqBh2kAtLgDqQjCz23dYnngTQvf8` | compliant | 0 | 888 |

Zincirden doğrulananlar:

- fiat iş 6QNeRLuyPt9ZtdcuaqBh2kAtLgDqQjCz23dYnngTQvf8 açıldı: ray `Fiat`, `Open`, vault yok
- fiat iş teslim edildi
- `VerifierConfig.mpp_authority` BFbPSNgmgByJDH1oYuVe7KTdZxdmtSV2vQ5hDxjddSCH (program upgrade'i yok)
- `ReleaseProof`: uyumlu, net işin tamamı 25 000 000 (25.000000) (keeper ücreti yok), payee agent; makbuz commitment'ı 00732532726fc7a977b81274bd251b05b94c35effcf9ea155665b2c6a28fd5f2
- fiat iş `Released`
- `ValidationRecord`: `Verified`, ispat bağlı
- itibar: tamamlanan iş +1, kazanç +25 000 000 (25.000000)
- günlük sayaç fiat ödemesi kadar ilerledi: 49 750 000 (49.750000) → 74 750 000 (74.750000)
- zincirde token hareketi yok: ödeme Stripe ile
- `VerifierConfig.mpp_authority` DsYG387f7aRAHNnd6iemmYwKjDP3xEMN9yUuVtWQc618 (program upgrade'i yok)

## Init kaydı (BC-30)

Küme: **localnet** · RPC: `127.0.0.1:48899` · tarih (UTC): 2026-10-06T22:37:43Z · commit: `fa0cdd5645054f3c54fe6b676365ddff58f99564`

### Programlar

| Program | Kimlik | Executable | Upgrade authority | Deploy slotu | Executable hash (solana-verify yöntemi) |
| --- | --- | --- | --- | --- | --- |
| `square_policy` | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` | evet | `HLu39g7o6z1E19BdsstTg15kXULxgvGq6QpKyxvduE5j` (yerel anahtar) | 0 | `be43658d1d7923f09bc139c3050f9beb7f4c1d487b9ede14a6cbfe91f8745d25` |
| `square_verifier` | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` | evet | `HLu39g7o6z1E19BdsstTg15kXULxgvGq6QpKyxvduE5j` (yerel anahtar) | 0 | `d7ec6985f645ad7eb57faf98d8c559bb5f9e0602e22d464e8389405a47faab52` |
| `square_registry` | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` | evet | `HLu39g7o6z1E19BdsstTg15kXULxgvGq6QpKyxvduE5j` (yerel anahtar) | 0 | `b15fc1aa794ea213e3c29cfe25f9749a6e37cdba32fa18016819f844ee65e79f` |
| `square_escrow` | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` | evet | `HLu39g7o6z1E19BdsstTg15kXULxgvGq6QpKyxvduE5j` (yerel anahtar) | 0 | `10ede5234f421c2dcb109cb4a04466b82db36d6b5999ef44d4bbcdc5c8825e16` |

### `square_registry` · `RegistryConfig`

Hesap: `EGDLUwrsTTFJaXEx1iHkUxm7SSdD4rnf1FG6CT9xRyj6`

| Alan | Değer |
| --- | --- |
| admin | `HLu39g7o6z1E19BdsstTg15kXULxgvGq6QpKyxvduE5j` |
| screener_authority | `5Nsv3twSyjNCNDUnTwSiexeuiYUE9Beogwyd3fSiankg` |
| screening_ttl_secs | `86400` |

### `square_verifier` · `VerifierConfig`

Hesap: `BM8WBhmvwyM3GdsHHQPAVg3XfcKE8e2q5AARjuCFmdX2`

| Alan | Değer |
| --- | --- |
| admin | `HLu39g7o6z1E19BdsstTg15kXULxgvGq6QpKyxvduE5j` |
| escrow_program | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |
| policy_program | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` |
| mpp_authority | `DsYG387f7aRAHNnd6iemmYwKjDP3xEMN9yUuVtWQc618` |
| vk_version | `1` |

### `square_escrow` · `EscrowConfig`

Hesap: `4rvvBywr8aT5o65g9wWdn3UoQ6YtFGpTLBBn1sQCKZDA`

| Alan | Değer |
| --- | --- |
| admin | `HLu39g7o6z1E19BdsstTg15kXULxgvGq6QpKyxvduE5j` |
| settlement_mint | `EZRZsN63hsuemjnwxXi1krZUoqt4QsZmsXEe4fYUrSNL` |
| registry_program | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` |
| policy_program | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` |
| verifier_program | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` |
| arbitrators | `yf2Gvxz5qiE6PVjSyiEJeaRpFfV7Cb5bn1YnkKskzGC, GQgoxjXyXCyL3E2UnDxGrRNCZSQdWyfc4yWXpRp7178Y, EnK4m8cm48rWCaQTnVDuwi87dnUJ47AZXfN9NbUTPg1P` |
| threshold | `2 / 3` |
| arbitrator_set_version | `0` |
| min_challenge_period | `1` |
| max_challenge_period | `2592000` |
| min_bond_bps | `500` |
| min_bond_absolute | `1000000` |
| keeper_fee_bps | `50` |
| proof_timeout_secs | `86400` |
| dispute_timeout_secs | `604800` |
| travel_rule_threshold | `3000000000` |

### Square ALT

Adres: `AbSvgtbGGXTye7epP1if6Qq7n1VabvPDWpcC7zQcLYSa` · authority: `ECM9E43VhACtBgPQmNPATNAXccYBzciKHH3ytAwhPZVm`

| # | Girdi | Adres |
| --- | --- | --- |
| 0 | `program:registry` | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` |
| 1 | `program:policy` | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` |
| 2 | `program:verifier` | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` |
| 3 | `program:escrow` | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |
| 4 | `pda:registryConfig` | `EGDLUwrsTTFJaXEx1iHkUxm7SSdD4rnf1FG6CT9xRyj6` |
| 5 | `pda:escrowConfig` | `4rvvBywr8aT5o65g9wWdn3UoQ6YtFGpTLBBn1sQCKZDA` |
| 6 | `pda:verifierConfig` | `BM8WBhmvwyM3GdsHHQPAVg3XfcKE8e2q5AARjuCFmdX2` |
| 7 | `pda:escrowAuthority` | `GyjbViCNwcPRJptkQvkpwKmwiyUMy9StaPJaoALSZ6ix` |
| 8 | `settlementMint` | `EZRZsN63hsuemjnwxXi1krZUoqt4QsZmsXEe4fYUrSNL` |
| 9 | `program:system` | `11111111111111111111111111111111` |
| 10 | `program:token` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| 11 | `program:token2022` | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 12 | `sysvar:instructions` | `Sysvar1nstructions1111111111111111111111111` |

### Init işlemleri

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| init | `init_registry_config` | `29v9CnuE3bYtub3hTXZtud2pQfpQ4UukKaKEZaLgFJvdTNBeoCTTLQTUMukrEsYeQEKuMbqKYkFJRs2ocUEKMHrF` | 9 392 | varsayılan | 10 203 | 460 | başarılı |
| init | `init_verifier_config` | `pkNfmtUYkgRDzM2mwySxt84CkSC89n5CgwVdE1p3oEAFyLNMQAguzRZ2MaEVEdWsTPFRuAksssLtANCsUzq8bfn` | 10 242 | varsayılan | 10 203 | 516 | başarılı |
| init | `init_config` | `2ssymdQmzGPGb4xZNDPhauttS1WbVTCyHZCDv2axYa3skDjiJCAQ7VqerS2Srh7SvwdTEgofKqKhxkF4RBBSVzQZ` | 12 160 | varsayılan | 10 203 | 702 | başarılı |
| ALT | `createLookupTable` + `extendLookupTable` | `2cgwuDBEpCbMJJY5dvgMLZgQG7Bqa8ZYh6kU4rFvgiVWJ5G9Xoz4bh9Wxh3yfRe7H1wmx3C4TrzvPXDiMgDt3T86` | 20 109 | varsayılan | 5 000 | 688 | başarılı |
