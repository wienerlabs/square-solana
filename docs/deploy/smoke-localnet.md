# Smoke raporu: localnet

> **Küme: localnet.** `solana-test-validator` (Agave 4.1.2) üzerinde, `smoke:localnet` koşucusunun açtığı geçici bir zincirde gerçek işlemler. **Devnet raporu değildir**: devnet kaydı gerçek deploy ve smoke'la `docs/deploy/devnet.md` ve `docs/deploy/smoke-devnet.md`'de oluşur (BC-30, BC-31).
> Programlar `target/deploy/*.so`'dan `--upgradeable-program` ile yüklendi; zincirdeki executable hash'leri `.so` dosyalarınınkiyle aynı. Upgrade authority, rol anahtarları ve mint (6 ondalık) koşu için üretildi ve koşu bitince silindi; imzalar yalnızca o zincirde geçerlidir.

**Issue:** BC-31 (#43) · **Üreten:** [`tests/smoke`](../../tests/smoke/)

| Alan | Değer |
| --- | --- |
| Küme | localnet |
| RPC | `127.0.0.1:48899` |
| Başlangıç (UTC) | 2026-10-06T22:28:59Z |
| Bitiş (UTC) | 2026-10-06T22:29:30Z |
| Commit | `87c660c2791785d532abe183363414aac29cdf68 +değişiklik` |
| Koşu | `20261006222859-e6fc` |
| Program kimlikleri | registry `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9`, policy `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4`, verifier `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh`, escrow `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |
| Settlement mint | `9aBzcEVXF9vLAfX688DgVYjsEa1wyEETurX7kzikNpcm` (6 ondalık) |
| Square ALT | `23JLy8MZg1GHxasyVBxZsP8tiSDxgvUsNaGTjQmz5k8y` |
| İş tutarı | 25 000 000 (25.000000) |
| Alacak fiyatı | 24 000 000 (24.000000) |
| Keeper ücreti | 50 bps → 125 000 (0.125000) |
| Challenge süresi | 5 s |
| Öncelik ücreti | 1000 micro-lamport / CU |

## Roller

| Rol | Adres |
| --- | --- |
| payer (ücret, rent) | `EL12jksMHnp6mpUT5HzHQhx1qFmUjFnRqaKfnfiqTes6` |
| screener authority | `UdR2qEfjfe5D4L5E9cgJXmSJC3hqxK38uA1aSXEFK4k` |
| kurum (imzacı cüzdan) | `45oQuT5YXrqWxiaKkycmMT6NEbKzV1bsspGuRr7kuLBk` |
| kurum (`Institution` PDA) | `3s7iMA4w9agmbGRvPapJy2Q3UETL4S38AyP8Mk5sizwp` |
| agent (sahip ve cüzdan) | `FEatVmGUJFYMY95WcBNgw8GSuL1vN2Gc4UsMDd1nQpVu` |
| alıcı | `6zhVToZuTMnyYGASwaj3VWgqe5LtJBFabg1q8zqvxefQ` |
| keeper | `HTNjdbPVSGDwaBQRXRmBdtkvMHTTbuD1dYFnpXSztusi` |

## Özet

| Bölüm | Tx | CU | Ücret (lamport) |
| --- | --- | --- | --- |
| Hazırlık | 1 | 13 668 | 5 203 |
| 8 adım | 13 | 517 205 | 126 390 |
| Varyant: ispat-ret (kesin ret → iade) | 7 | 370 267 | 65 930 |
| Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir) | 7 | 428 678 | 61 090 |
| Varyant: fiat (Stripe MPP attestation, BC-37) | 7 | 283 980 | 70 996 |
| **Toplam** | 35 | 1 613 798 | 329 609 |

## Hazırlık

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | keeper'ın ATA'sı (idempotent) | `4fqEnu2HQJPsf4juRzenfSVHXLNBdSy9NsheSq9hBYnbDVwJicDS5MfwFZ3vuYDc3AhKwVZPsUuESbvxNUCu9A1e` | 13 668 | varsayılan | 5 203 | 323 | başarılı |

## 8 adım

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `initInstitution` + `setPolicy` + `setBuyerRoot` | `38rvMBm7ATytouN3FUwAScrTmB2amjgDnhavyMeTSVJaNPn8bkAry8uT3u7WAbPaW2HPRBNWuB7AshiBmR6o81uc` | 30 346 | 130 000 | 10 130 | 587 | başarılı |
| 2 | `registerAgent` | `ZAhxupBukXsPqZNqriHBbU6aJzr2teVpr2CFghZNjeXvyKg2nB6gqpbRJ4FEPNgYQBoAyZZyCm4a4SpYuyo4B4Y` | 15 301 | 40 000 | 10 040 | 495 | başarılı |
| 3 | `recordScreening` (kurum) | `2UpecFFcN5RG37pmxV59jFpMGfAYomYVW8RBnkPe7xbK66ZFfgdDQ5tpTD2aDfzwec9jkrbKurGfqe58awhYipA8` | 10 554 | 60 000 | 10 060 | 465 | başarılı |
| 3 | `recordScreening` (agent) | `NK7mkSrxGgTUMmPtyZkqnsMyd7qkWCjyE5x3yXk92FcLxb72taxatE6pMGxZZMFcEDe3DUFrQEEiZDVwfvsAarb` | 25 554 | 60 000 | 10 060 | 465 | başarılı |
| 3 | `recordScreening` (alıcı) | `2XRdhXwR7kcdARqSEoUJuwrDx3LUjz2xinRyEa2gmSzWbvJ3y8vCWAVB722YzTuT8JypLK7pjDwg1F5e7K6jEgFW` | 12 054 | 60 000 | 10 060 | 465 | başarılı |
| 3 | `createJob` (politikalı) | `YufYaVFR76PTReTbyPRHF22hX6xbSaTFPRhqULoQE7G1X52zhEbkhRXPriwbBA9YDMigtf6wHVpnSobyfrJa9Gf` | 37 897 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `2gaY2WfsePCwZDiohsmN2ou6nsWMEJwhrit79qXufdUdHWx4ZoWuGXPf3tShqyAFSyQDSdvKmjzPqbbHUCqUH7pR` | 53 149 | 120 000 | 10 120 | 533 | başarılı |
| 4 | `acceptJob` | `HUgQQewRqSH9u1YyZpk3StUWFGAd2VbeATqLSJ1CngvikhMnqiAAByVB9WtejxNMaoLqX1ChP6e3qjF66kT6Bxb` | 7 642 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `4xMGPkV7Xo5eR5cjHTNj84DkBWPSaFTTEM2zk2nDy43K5VgVip5UQVjRSG4CFfNCNz1VWPwpyeH5VzCFvi4iVL8z` | 8 196 | 20 000 | 10 020 | 477 | başarılı |
| 5 | `listClaim` | `5R4hc7kC2uNn52QTh2X9rchSWn2v28fJqmor3T13FTPuDmedAjcY7GvztkHTUBgk6RtUuiUarGmEKix1JiakHa4f` | 12 396 | 50 000 | 10 050 | 439 | başarılı |
| 5 | `buyClaim` (Merkle kanıtlı) | `676cpg5QCDZpWnDnxbe5a5uHycgkqh54yT5fBGijd21gx5YZByPEDfEzEa6q2wwURmurPf5WUcyw5tGN3WN85gPT` | 41 344 | 120 000 | 10 120 | 685 | başarılı |
| 7 | `setComplianceProof` (Groth16) | `ck5e1acwayhBAU75gA9cptjtftTjQ9LvgxRFJ5kmGNJWKHsCm3kvBSwHuFy226yFDPSbkFpj2WB7PvWQCSXNTFh` | 178 781 | 390 000 | 10 390 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `2J6nMKGP8eKFTiBMmZDvLVLkWJWixc5wYQQf6k3YwkHhVqR8pMhWhrvnLo8HEMNCSayD2jhLW8Fvmwh2HCZK9vZt` | 83 991 | 220 000 | 5 220 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `3Ptep4c3suk5TgbTBwbEaRn711suupRHe9hADVk7qSxZ` | compliant | 0 | 880 |

Zincirden doğrulananlar:

- `Policy` FwBRb8qs1ySJgyZHyBZEcT6nSavR484kKk2XaeegaTUy: commitment yerel politikayla aynı, public tavan 25 000 000 000, sürüm 1, aktif
- alıcı kökü 2523aa4db3e6ec59a15ad93e039741e8927b1bb34bf187637a3c21d085b3e531 (1 onaylı alıcı)
- `AgentRecord` 6ajjM5DkFTTpp5HYiCMrpgv5EK2DhCHDgVnC1qmMbUPZ (`smoke-20261006222859-e6fc`): cüzdan agent, durum aktif
- kurum screening'i temiz; geçerlilik sonu 2026-10-07T22:29:00Z
- agent screening'i temiz; geçerlilik sonu 2026-10-07T22:29:01Z
- alıcı screening'i temiz; geçerlilik sonu 2026-10-07T22:29:01Z
- job 3Ptep4c3suk5TgbTBwbEaRn711suupRHe9hADVk7qSxZ fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T22:29:08Z
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
| 1 | `setPolicy` (işlem başı tavan 1) | `51yX7uh7QwtMFzK9ygYmkrBeZWcQtHwci2ghnv1f6Fu6dKG4HbDjfSnHjeh1C5JZrJNqyqmTunjCUzVESQdaEMiG` | 12 793 | 60 000 | 10 060 | 503 | başarılı |
| 3 | `createJob` (politikalı) | `4AbiGQK6RW7umBoAyUQdWGkYCq1ksQrb3ANYK1fhMwghKwpvxq2rXiMXkKaRfHNbGYxUmts137zfWL5dLAzdZUH4` | 30 397 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `4AyoVjJQNxqLANUyq2goVa1acTZQFBZSDc83Dw4MJXuegGxxuveqPtMCj3mvdAiDVGnmiXMZ3BvLp5z3Sbf1fDag` | 53 149 | 120 000 | 10 120 | 533 | başarılı |
| 4 | `acceptJob` | `2tLcqgKybeXSbCoRzsdqj1fAXP76vYXhhmjxph3xbW3CMqJFd9V68EYJ3i61Vs72TDqSVre47PSDWuDSxp19CCcL` | 7 642 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `5ebYTj4t1ezc5BsPvDCcq5tpmqufX5kX6Rp4XEJtL2BJMTwpDrhL2r4H7gNZ4145JmxY6BuidUKFiLDUc6HC7DTT` | 8 151 | 20 000 | 10 020 | 476 | başarılı |
| 7 | `setComplianceProof` (Groth16) | `45g9DVdc5L7zuq2nybVYx3r9hnz8mXLTksjdS3Tnd79o3azjchLAxpito9ofu2wfpPuHrwGnS9ACt9HzzifZJ79s` | 176 071 | 390 000 | 10 390 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `4rm2vNrAjW5P2iAenrCpzczEshbiAHwBVQrPxCGzEeG8Fg5vZY5nJAUX83mpTcK1TkyqMhqZiSJ8SamtzSRCn3FP` | 82 064 | 220 000 | 5 220 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `Fd3dc6y6hzGKJCUxN5fc6j9toWxaDgzNNP1BxBTmjamf` | refused | 1 | 680 |

Zincirden doğrulananlar:

- `Policy` HGEzQKrHULiWHLnhe4fTc5X5Dw1xY6V9nhATQ6ea84TP: commitment yerel politikayla aynı, public tavan 25 000 000 000, sürüm 1, aktif
- job Fd3dc6y6hzGKJCUxN5fc6j9toWxaDgzNNP1BxBTmjamf fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T22:29:16Z
- `ReleaseProof`: ret, kod 1 (perTx), kesin ret
- job `Refunded`
- net kuruma iade edildi: 24 875 000 (24.875000)
- keeper ücreti yine ödendi: 125 000 (0.125000)
- `ValidationRecord`: `Refused`, ret kodu 1
- itibar: tamamlanan iş ve kazanç değişmedi

## Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | `createJob` (politikalı) | `4ng4U7x1TDffQ9EQZ1vBsNqtmkdNPfqbZ8cu7SvPfzj3JL3snQuakWE3F8G4WgU7JZyrh95AZQDuYkbPCTHAgBP2` | 28 897 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `2WmChTUjopHJiLSnS2priYUc1Lpb5DQuHPxUrhonDNbAq1eayHRJjtWSaDGL9gPhb2Jvvjx67NQLvyHLYb7H3mkC` | 53 149 | 120 000 | 10 120 | 533 | başarılı |
| 4 | `acceptJob` | `2TLfvjjKS6wTPxn3uhWuwrAx6R5jqfXTm6ioz1xo6QGQfufqxp4msLJDbV9XRMJY27ZHTyQwcSsuWQ3WZXqFHYpj` | 7 642 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `qyNbNRMSNovRTeeKTF5JwEPEjiH1QuZcjsVv3VX9mTekf3CjTyecQ6HoYdCNooPtGyCHEGzNS5Cbgo26XRvcfJK` | 8 151 | 20 000 | 10 020 | 476 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `2niXM7aS1H7v4bFQkXWunfUi3w5A91WmGubqasmxJtgbZM7AkhzGR1823n9tEo27GZUDmvYTXKfLpn53Bf8GA9Ct` | 57 364 | 220 000 | 5 220 | 792 | beklenen ret: `escrow::proofRequired` (6039) |
| 7 | `setComplianceProof` (Groth16) | `35r9g3Adx9veB2yFHa9CG81Ljy3Ss9E1Wz7fwPtqPk6Padf1Wb4FqKAzU9UJYTrVRsFXAsFhmd5VtdBMNyhZ5y5e` | 174 569 | 390 000 | 10 390 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `4ZLe6jCwco4Ag6H7HVayMLKBTHawJ2b4kDZonbTWCHQvdVZyXBcjYHL7hqk1obYtumk1ejaBXe4ikt6SLAdPJhB` | 98 906 | 220 000 | 5 220 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `AevyZb4zNFKP9ahi8wv4PppqZAuJBpn76nBcUmqvgwbR` | compliant | 0 | 702 |

Zincirden doğrulananlar:

- job AevyZb4zNFKP9ahi8wv4PppqZAuJBpn76nBcUmqvgwbR fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T22:29:23Z
- finalize `ProofRequired` ile düştü: job `Delivered`, vault 25 000 000 (25.000000) (escrow bekliyor)
- `ReleaseProof` hesabı yok
- `ReleaseProof`: uyumlu, payee agent (alacak satılmadı)
- ispat bağlandıktan sonra job `Released`
- agent'a ödendi: 24 875 000 (24.875000)

## Varyant: fiat (Stripe MPP attestation, BC-37)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | `createFiatJob` | `4oCSJQeHpprrjcs1yQE2wM9cEDnvbagPJxuFQp4v8oshn8x2Kp17hFpQddTq98k52MSZbwHRaCvFHe9U4vrzpxJb` | 41 319 | 70 000 | 10 070 | 613 | başarılı |
| 4 | `acceptJob` (fiat, açıkken) | `TePvx1CbyLWmJm4cMw3i93BCsE1s5oseQLSuARwPwD41xb5oQK5WYandNx6FVaVz2JXuWePp55ZwD7c421rsQPr` | 7 640 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `48DwZY2i1uQ56MTJhudcgsk1FK87ozsjfo7SeqbrDZhXWux8caukjYoqQHG1T3DnFy7iLTFQsg4UhiuujqzUWbsU` | 8 075 | 20 000 | 10 020 | 471 | başarılı |
| MPP | `updateMppAuthority` (yeni anahtar) | `4BGR27UqgJX9fqgGaQ84wLukuAUBbWWJCwcZ9as7Cc9qKYVWEFx3hTms5wjuzeiH6KHAHGGCbF343WTRF1xd9h7m` | 4 271 | varsayılan | 10 203 | 388 | başarılı |
| 7 | `verifyMppPaymentProof` (Ed25519 attestation + Groth16) | `534BbJYJm19mU5M7NU6TARj3Wc2sXfNpDyEsZ5QcYa14VXamFuZ331xYkTnW3tBBfb5N8zdfZBQEBKTRkzRqqiTa` | 172 342 | 360 000 | 15 360 | 1076 | başarılı |
| 6 + 8 | `finalizeFiatPayment` | `5zp4feaaQ99NJKTBeUx7PM2mGvAoztFpkn6jA8pj3nXGdCCYTdFgM8tgqyfwSoeGiRr2zDWfkub7jiWzx9SJsk5L` | 46 062 | 120 000 | 5 120 | 441 | başarılı |
| MPP | `updateMppAuthority` (eski anahtara geri) | `yxe7oMxBnHpgTxM4RZxK5WmWoqEQnEvaQmndQ7sr4aJK6uaXsbxY4jERzrrdoKYsvcm2rtYjct94LnNbfmQeCYx` | 4 271 | varsayılan | 10 203 | 388 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `FWmdSd7btByXkuMLVprCSNgxTwPfD3eJjbjftRUY1XF4` | compliant | 0 | 674 |

Zincirden doğrulananlar:

- fiat iş FWmdSd7btByXkuMLVprCSNgxTwPfD3eJjbjftRUY1XF4 açıldı: ray `Fiat`, `Open`, vault yok
- fiat iş teslim edildi
- `VerifierConfig.mpp_authority` F7aB62cZbEKcUGegiR6WE5TwjkNYaRYaLTLNvtonv6jo (program upgrade'i yok)
- `ReleaseProof`: uyumlu, net işin tamamı 25 000 000 (25.000000) (keeper ücreti yok), payee agent; makbuz commitment'ı 0d3395a902cf112c00b18e4aa7851f4c72f13249d32853ed35a6143302b335fa
- fiat iş `Released`
- `ValidationRecord`: `Verified`, ispat bağlı
- itibar: tamamlanan iş +1, kazanç +25 000 000 (25.000000)
- günlük sayaç fiat ödemesi kadar ilerledi: 49 750 000 (49.750000) → 74 750 000 (74.750000)
- zincirde token hareketi yok: ödeme Stripe ile
- `VerifierConfig.mpp_authority` 4xDLXVfXaoRZfFN2BQGSYXUHAcpdLiyHtFq4zvBuL7dW (program upgrade'i yok)

## Init kaydı (BC-30)

Küme: **localnet** · RPC: `127.0.0.1:48899` · tarih (UTC): 2026-10-06T22:28:59Z · commit: `87c660c2791785d532abe183363414aac29cdf68 +değişiklik`

### Programlar

| Program | Kimlik | Executable | Upgrade authority | Deploy slotu | Executable hash (solana-verify yöntemi) |
| --- | --- | --- | --- | --- | --- |
| `square_policy` | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` | evet | `GiTFhkzYXjQo6kkkg46W5Lo3bxzScAnJxx1xFrkp7SXw` (yerel anahtar) | 0 | `be43658d1d7923f09bc139c3050f9beb7f4c1d487b9ede14a6cbfe91f8745d25` |
| `square_verifier` | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` | evet | `GiTFhkzYXjQo6kkkg46W5Lo3bxzScAnJxx1xFrkp7SXw` (yerel anahtar) | 0 | `253d0f38fdbff6e446f42541cb3612aac34d89242a1d8a2a27b7fb27754f7ada` |
| `square_registry` | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` | evet | `GiTFhkzYXjQo6kkkg46W5Lo3bxzScAnJxx1xFrkp7SXw` (yerel anahtar) | 0 | `b15fc1aa794ea213e3c29cfe25f9749a6e37cdba32fa18016819f844ee65e79f` |
| `square_escrow` | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` | evet | `GiTFhkzYXjQo6kkkg46W5Lo3bxzScAnJxx1xFrkp7SXw` (yerel anahtar) | 0 | `7d8db1f936572fa32284daf980c423414630e32b732ed1eeaa7cd3db3ca0b5b9` |

### `square_registry` · `RegistryConfig`

Hesap: `EGDLUwrsTTFJaXEx1iHkUxm7SSdD4rnf1FG6CT9xRyj6`

| Alan | Değer |
| --- | --- |
| admin | `GiTFhkzYXjQo6kkkg46W5Lo3bxzScAnJxx1xFrkp7SXw` |
| screener_authority | `UdR2qEfjfe5D4L5E9cgJXmSJC3hqxK38uA1aSXEFK4k` |
| screening_ttl_secs | `86400` |

### `square_verifier` · `VerifierConfig`

Hesap: `BM8WBhmvwyM3GdsHHQPAVg3XfcKE8e2q5AARjuCFmdX2`

| Alan | Değer |
| --- | --- |
| admin | `GiTFhkzYXjQo6kkkg46W5Lo3bxzScAnJxx1xFrkp7SXw` |
| escrow_program | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |
| policy_program | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` |
| mpp_authority | `4xDLXVfXaoRZfFN2BQGSYXUHAcpdLiyHtFq4zvBuL7dW` |
| vk_version | `1` |

### `square_escrow` · `EscrowConfig`

Hesap: `4rvvBywr8aT5o65g9wWdn3UoQ6YtFGpTLBBn1sQCKZDA`

| Alan | Değer |
| --- | --- |
| admin | `GiTFhkzYXjQo6kkkg46W5Lo3bxzScAnJxx1xFrkp7SXw` |
| settlement_mint | `9aBzcEVXF9vLAfX688DgVYjsEa1wyEETurX7kzikNpcm` |
| registry_program | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` |
| policy_program | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` |
| verifier_program | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` |
| arbitrators | `6XMJxgFDwRtPtYd61qdiEehbrN7m7omFUuN5RnSWcFtc, 6AbZohbEwowgsRjmi82yueXRZiSHtY4CaScL5cYNTXTT, HnxPc7GYmwpXSsPooEYZTcoDsBtn8f6w9VPiaZve65hT` |
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

Adres: `23JLy8MZg1GHxasyVBxZsP8tiSDxgvUsNaGTjQmz5k8y` · authority: `EL12jksMHnp6mpUT5HzHQhx1qFmUjFnRqaKfnfiqTes6`

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
| 8 | `settlementMint` | `9aBzcEVXF9vLAfX688DgVYjsEa1wyEETurX7kzikNpcm` |
| 9 | `program:system` | `11111111111111111111111111111111` |
| 10 | `program:token` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| 11 | `program:token2022` | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 12 | `sysvar:instructions` | `Sysvar1nstructions1111111111111111111111111` |

### Init işlemleri

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| init | `init_registry_config` | `379c2JmYvyXEuDbAvHYBVeioQccYTmxYo99mpY3Yj9exqHpRKNE2NXLbWvsxcLSJVWnHv9J7a4ystZA1pKurvuyq` | 9 392 | varsayılan | 10 203 | 460 | başarılı |
| init | `init_verifier_config` | `TArLGW8y8EwKXPuCqUxnB2mmbHJc2oaKz18DLbTySgRkXoNtpNbfRN4KNGqbjuV3LWUCKdCXmz6ThHQwTfPmB5r` | 9 729 | varsayılan | 10 203 | 516 | başarılı |
| init | `init_config` | `2HsC12WNXWRbbBQM3zc8G4XrqZvegK5WxW7vZPxjSA96vpWqSt6Ea4Fhr3tJr3wshFPwVNci9u8bA8cQYWNippCa` | 11 628 | varsayılan | 10 203 | 702 | başarılı |
| ALT | `createLookupTable` + `extendLookupTable` | `4JhRhL4ukZiSLMW2teJehBK11vTR31s4yKQSjftu7V7zKqiby37e3qpgi8TB4jKLyDwXKXvuD2atshvVZ5qYRqog` | 20 109 | varsayılan | 5 000 | 688 | başarılı |
