# Smoke raporu: localnet

> **Küme: localnet.** `solana-test-validator` (Agave 4.1.2) üzerinde, `smoke:localnet` koşucusunun açtığı geçici bir zincirde gerçek işlemler. **Devnet raporu değildir**: devnet kaydı gerçek deploy ve smoke'la `docs/deploy/devnet.md` ve `docs/deploy/smoke-devnet.md`'de oluşur (BC-30, BC-31).
> Programlar `target/deploy/*.so`'dan `--upgradeable-program` ile yüklendi; zincirdeki executable hash'leri `.so` dosyalarınınkiyle aynı. Upgrade authority, rol anahtarları ve mint (6 ondalık) koşu için üretildi ve koşu bitince silindi; imzalar yalnızca o zincirde geçerlidir.

**Issue:** BC-31 (#43) · **Üreten:** [`tests/smoke`](../../tests/smoke/)

| Alan | Değer |
| --- | --- |
| Küme | localnet |
| RPC | `127.0.0.1:48899` |
| Başlangıç (UTC) | 2026-10-06T10:02:32Z |
| Bitiş (UTC) | 2026-10-06T10:02:58Z |
| Commit | `6466313a10f8619265658b9f4639b4a417236c6a +değişiklik` |
| Koşu | `20261006100232-f97b` |
| Program kimlikleri | registry `CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc`, policy `FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU`, verifier `AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU`, escrow `5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT` |
| Settlement mint | `7TuA1E4nPzN7HNdqCLykHkQWZxMUhdMr3noSqFnwnbdP` (6 ondalık) |
| Square ALT | `GDBW6uAdnhs3dbLoU8YJHaQbFXy11cFkc3iHQwPqDmbw` |
| İş tutarı | 25 000 000 (25.000000) |
| Alacak fiyatı | 24 000 000 (24.000000) |
| Keeper ücreti | 50 bps → 125 000 (0.125000) |
| Challenge süresi | 5 s |
| Öncelik ücreti | 1000 micro-lamport / CU |

## Roller

| Rol | Adres |
| --- | --- |
| payer (ücret, rent) | `GmCDcYodVvCAsdwyDvRuxT3m4rVuFdiXkuhbevGXzHbU` |
| screener authority | `7LSx1GKXXdgykFHDHGmUzwsa8zkP7bhE8NhBx3NpH1V7` |
| kurum (imzacı cüzdan) | `9C5y2937mYjHCM4URwbwRPJNeB4fTrBbfHgQN3oe7zWq` |
| kurum (`Institution` PDA) | `5VbFwmjJ8gXoWzYcJxP524FKox2mvaVm9v9kJN26msoj` |
| agent (sahip ve cüzdan) | `4mccduscPrZXw2wdxPYps3UpsvJ3QdmjoYyj3Xkn478t` |
| alıcı | `4eRunN51eoV8YRknFwTt5z5mVZsPkDLbeG9KXm2YJ2mn` |
| keeper | `3W6dXXULwvMv4mJrsba95cPzctYCuDM8TNMmYqj7xjPM` |

## Özet

| Bölüm | Tx | CU | Ücret (lamport) |
| --- | --- | --- | --- |
| Hazırlık | 1 | 16 668 | 5 203 |
| 8 adım | 13 | 489 000 | 126 220 |
| Varyant: ispat-ret (kesin ret → iade) | 7 | 338 217 | 65 830 |
| Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir) | 7 | 390 818 | 60 990 |
| **Toplam** | 28 | 1 234 703 | 258 243 |

## Hazırlık

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | keeper'ın ATA'sı (idempotent) | `5u3bywdHz6MLvesB9s1zgGHvn1GzPy7xKAHnXxb2jZNX9EaByQZJ7TndhrakMAJqQXNbz8iTqcTHRDr71LD87wkR` | 16 668 | varsayılan | 5 203 | 323 | başarılı |

## 8 adım

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `initInstitution` + `setPolicy` + `setBuyerRoot` | `4nspruHKDTQUNcZX1vaD1dNCRGFtt1xNmTYtEbXHqLmKmh71JqhZB5hBWkyQ1dYUFaTV72afhfQ41rSosyByCSPJ` | 30 013 | 110 000 | 10 110 | 587 | başarılı |
| 2 | `registerAgent` | `2aW5kNReFxNeHrNEYQPN98b7mUCpCDg1aFuzAQ6tAnrJFkY6QGMmsNqDD458VLQVpwLUKRKdHMYPyjdMr5zjhsut` | 11 283 | 40 000 | 10 040 | 495 | başarılı |
| 3 | `recordScreening` (kurum) | `3VesVWnf2TFWCFt74Qdfh2DXVDKrpXMzoLFaWsiQqskrqx45sY9Y56a7MUVesTLTnpnvivsrKtEv8tYDszCAULGL` | 11 028 | 40 000 | 10 040 | 465 | başarılı |
| 3 | `recordScreening` (agent) | `2X41C56r7PTBxbE4dFj7rQNJS8ecXe8TMP72UskanjVZYWB5zPem9bsjCGg8Fs8SnywytzY59eHGK7TvyNxZ8sKs` | 12 528 | 40 000 | 10 040 | 465 | başarılı |
| 3 | `recordScreening` (alıcı) | `4AqnXqSHZxUYmvyp9125tQwtxYwH41WywJ5E7LVVe4UFBSjUauWUUeTxo3Z2Wn3RMHzyzZhWjqB8o2brTzgMr7ar` | 18 528 | 40 000 | 10 040 | 465 | başarılı |
| 3 | `createJob` (politikalı) | `2EcKYU35vMT7kQJgdm99gabNmpreHmTGQoQEnowtsJxei1CLjQMkg2QyofX5v3jF36T6dMJrQkr9WCoPFFyLKMD2` | 32 559 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `2cKbK9oAuVAdEzjQ9zPKJMZgzEB3tbzzsWsyr6Ktce4w6rf35R1PaLqunwhZv1vrtTGFxTuS5KU7ZxfBLA4DNYEE` | 26 504 | 90 000 | 10 090 | 533 | başarılı |
| 4 | `acceptJob` | `CTPMQkPi71LAwFU885hKQ6WKpTT1BwUf8EeywSbd7bZchoaxH2v54ekA4siBAoFeSY7pU9kC952RQDjHZ6XXapF` | 7 810 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `eMFWQFxzPrjzM51bekf84euQSFqrx8AkfqMLvyX1uDpQmgB6hogUn33d8nQcXNnAraw8X2Rext9j26gDBScrD2f` | 8 363 | 20 000 | 10 020 | 477 | başarılı |
| 5 | `listClaim` | `1RXRvf9t6Mx2RWMohZSM28L83pM2upFtBNTyttdWTybTPxGETYRLVTBDLwvJ2cgRU6xLuZXe7GuSbthhrK6QtsS` | 11 340 | 50 000 | 10 050 | 439 | başarılı |
| 5 | `buyClaim` (Merkle kanıtlı) | `5Gi1bSTuuncWTiuMhNK33BMrA1QNAoxTqEUc9tmjXnTFiPCjWbdRV4LoaUApztEG4kGFKpxGsMUeCg3yJ4ut7ubi` | 49 284 | 110 000 | 10 110 | 685 | başarılı |
| 7 | `setComplianceProof` (Groth16) | `517r93Dt7a8vEaZ4wSCN5oanA3z3fAs9q7U7VrQbpJJAGETf9WhmQs9R6wVEAZyzosxrWMbkDu6FCehpB8sS4QyS` | 176 752 | 360 000 | 10 360 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `2zNjdkCvyJ7wNKKVTAmSLZxgwfcNHYhih8wrMvtMg2DHUzefnF8PdykZsTRgEHVU5hnCXbtM7KggM64HDwPE3gd5` | 93 008 | 200 000 | 5 200 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `D3xNzb3dGKDLSEKXbKuSvJiXP2Gh7oHdKV8Q4XfJCgQ5` | compliant | 0 | 1 677 |

Zincirden doğrulananlar:

- `Policy` EXfH3NhjJc6LwU1q6NQqdkeppqYriinCYkTgiHHoiK3L: commitment yerel politikayla aynı, public tavan 25 000 000 000, sürüm 1, aktif
- alıcı kökü fab794f72b69b2607d760a320f2cc1161268a2230d5721776d0738f9595f3754 (1 onaylı alıcı)
- `AgentRecord` CdFmerJZJWWxMAHyARFmmXZc3APfCN96h6npH5zBKxin (`smoke-20261006100232-f97b`): cüzdan agent, durum aktif
- kurum screening'i temiz; geçerlilik sonu 2026-10-07T10:02:33Z
- agent screening'i temiz; geçerlilik sonu 2026-10-07T10:02:33Z
- alıcı screening'i temiz; geçerlilik sonu 2026-10-07T10:02:33Z
- job D3xNzb3dGKDLSEKXbKuSvJiXP2Gh7oHdKV8Q4XfJCgQ5 fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T10:02:40Z
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
| 1 | `setPolicy` (işlem başı tavan 1) | `58swr6kSoe2ueyKckzDWy45gpo9A5sBSdm4ft13E6MecASUkA2WoGaYaGfzNgRktr1sD95ssw2WW3jvS1vqBxG7V` | 11 801 | 40 000 | 10 040 | 503 | başarılı |
| 3 | `createJob` (politikalı) | `T2sKKanchZ4VbzSCagP4s6igpCw9WeQvamU8aXUvM6Gnnvi3NFS2P26jFJr2KzykHwyw8kiUwrxeAiXHLjhD4w7` | 29 559 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `5MPnfLUcqLPgy3rSbEBVzsHMGwdQCprph53hG8U57tasMF8W3wFnNPZxUUJVHpYQAd9WYGn4SLmuLqivjwBfspsb` | 26 504 | 90 000 | 10 090 | 533 | başarılı |
| 4 | `acceptJob` | `5mCC7XSs8m7qJaNxBzjBMxBMXVvHy7CsFZW4HZzegG5REzAEJNxYAo5eEStNJsu8j6YGwpu9Y8A7z26UeKeUo6Fk` | 7 810 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `iuyMBmRddGcTnacrBYbcR2DkW7rcEw4s8rxokBbmemVG5d4svmu1GuuQDgamaPQuYYpqQTGDk6Sm5P8m58VeJpL` | 8 318 | 20 000 | 10 020 | 476 | başarılı |
| 7 | `setComplianceProof` (Groth16) | `2SVfeAP4R8duUNxq1FSzeUAyHcJH9cA58MNKCim7YCWWsEpmSiV38mPZRaiwSagzpcRSp44Qzx7Hk1NMaNBjFCWK` | 175 345 | 360 000 | 10 360 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `2jusLk6J93iVHV7fatRcmtNPmiAdvc9q1WQCGwK5TbgHvBARvBTzH3y3RT3kxi5Q3YRbFX4tgwy7hx4vvrGihfM` | 78 880 | 200 000 | 5 200 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `BH4CR6QTtNXLwdBsjcfABQxF4Cy9FNKGBynfotZEzd1r` | refused | 1 | 1 282 |

Zincirden doğrulananlar:

- `Policy` H4pBj6kDF3oHYaSeefMiUzanoW7cGvd3J1MTubXGnW7r: commitment yerel politikayla aynı, public tavan 25 000 000 000, sürüm 1, aktif
- job BH4CR6QTtNXLwdBsjcfABQxF4Cy9FNKGBynfotZEzd1r fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T10:02:47Z
- `ReleaseProof`: ret, kod 1 (perTx), kesin ret
- job `Refunded`
- net kuruma iade edildi: 24 875 000 (24.875000)
- keeper ücreti yine ödendi: 125 000 (0.125000)
- `ValidationRecord`: `Refused`, ret kodu 1
- itibar: tamamlanan iş ve kazanç değişmedi

## Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | `createJob` (politikalı) | `4Ud6tjXqfUfSv1bufXyHXFxebtKfeqsde85EkFw4QbSbvAniT6kZ49XjzNfURzzBHEgbMRuoReajqHMcsE7KdbVp` | 32 559 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | `B63ydFx6KJPc4Y5he3WqKdSHqy5PyjqmtMMjYVWFqhynbTDwBM3CiDmYpCvKDXTdJ5NWiAxVkDYgAaMRLrAEqwU` | 26 504 | 90 000 | 10 090 | 533 | başarılı |
| 4 | `acceptJob` | `4oM3HaWGYBe25JayFEtqFgDoAhxh7bDYe1HcrajzAnDwHWAuLRLHXwgaAancoaQdrZaZPiPWnB6nU2HRTZJuVLcu` | 7 810 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | `55chsaqerGCTGMJTgGjTjrQRf5awA5NjRkNM72kPihe9Ez5HEj1oUW6fYRrLLf6iDP82rzNgQtvnWKRV4U28Mig` | 8 318 | 20 000 | 10 020 | 476 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `nNY9FZ4fHkYM9vUFhdPPZurNRbXvx9BJBjKu7NCZavD63gvoNkcAUJBoXifYDFf6Ve9QBXx5qBs4cGvZzuprBnR` | 55 064 | 200 000 | 5 200 | 792 | beklenen ret: `escrow::proofRequired` (6039) |
| 7 | `setComplianceProof` (Groth16) | `4Y8FnKJH4NJqQUELPEq8pWvU22ofT2zE8eA4iE7EaADJRaAtG9NY4kAWYhzsTUonmE2QsiuahkSHdEQdZViBH4NQ` | 175 342 | 360 000 | 10 360 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | `fQ3wECKSu2StA1hXQ6QXASXQ6WGiMtCC5HqknrtZvG7KFPemVXTVPgHKEVhq8qzNnN2BSpz6m35MaMrmoV24iWb` | 85 221 | 200 000 | 5 200 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `GjNuirb7GHw9mzZTgNb6tZdeKuQwqfizJNnUF1ijEdZb` | compliant | 0 | 2 216 |

Zincirden doğrulananlar:

- job GjNuirb7GHw9mzZTgNb6tZdeKuQwqfizJNnUF1ijEdZb fonlandı: vault 25 000 000 (25.000000)
- job teslim edildi; challenge sonu 2026-10-06T10:02:54Z
- finalize `ProofRequired` ile düştü: job `Delivered`, vault 25 000 000 (25.000000) (escrow bekliyor)
- `ReleaseProof` hesabı yok
- `ReleaseProof`: uyumlu, payee agent (alacak satılmadı)
- ispat bağlandıktan sonra job `Released`
- agent'a ödendi: 24 875 000 (24.875000)

## Init kaydı (BC-30)

Küme: **localnet** · RPC: `127.0.0.1:48899` · tarih (UTC): 2026-10-06T10:02:32Z · commit: `6466313a10f8619265658b9f4639b4a417236c6a +değişiklik`

### Programlar

| Program | Kimlik | Executable | Upgrade authority | Deploy slotu | Executable hash (solana-verify yöntemi) |
| --- | --- | --- | --- | --- | --- |
| `square_policy` | `FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU` | evet | `2Ugv8pWJ91mERfavMksgP63ukNMVj4RnCZqtyqKTxct8` (yerel anahtar) | 0 | `9b51e22b92d0c6df9f2701904718d3b5b65050e0d9f38efe10481743a572f213` |
| `square_verifier` | `AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU` | evet | `2Ugv8pWJ91mERfavMksgP63ukNMVj4RnCZqtyqKTxct8` (yerel anahtar) | 0 | `094334f42f383a408b3a20be96053e41b4df2579b63f57030a68917f02d794c9` |
| `square_registry` | `CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc` | evet | `2Ugv8pWJ91mERfavMksgP63ukNMVj4RnCZqtyqKTxct8` (yerel anahtar) | 0 | `17306b29290b604b1b48d06a9aadef9a50c2bb89f21e169f16d8d43dd785e300` |
| `square_escrow` | `5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT` | evet | `2Ugv8pWJ91mERfavMksgP63ukNMVj4RnCZqtyqKTxct8` (yerel anahtar) | 0 | `f4d476c5badda6b818e30fae22ae918ffc552297a90d466b586f986f82b2101e` |

### `square_registry` · `RegistryConfig`

Hesap: `HuuRXScYCvFmzCdvu1k2cvtQ3PtdswK5ZYthuJqNTRmq`

| Alan | Değer |
| --- | --- |
| admin | `2Ugv8pWJ91mERfavMksgP63ukNMVj4RnCZqtyqKTxct8` |
| screener_authority | `7LSx1GKXXdgykFHDHGmUzwsa8zkP7bhE8NhBx3NpH1V7` |
| screening_ttl_secs | `86400` |

### `square_verifier` · `VerifierConfig`

Hesap: `5YznQmuHZx3YhqpYujUupQjrNjau6bATiAmWVK2Cyw3c`

| Alan | Değer |
| --- | --- |
| admin | `2Ugv8pWJ91mERfavMksgP63ukNMVj4RnCZqtyqKTxct8` |
| escrow_program | `5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT` |
| policy_program | `FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU` |
| mpp_authority | `F7MJwt8dDbysPYxKkCN1fXtKxRb6JKxxweHTs2Uftk7p` |
| vk_version | `1` |

### `square_escrow` · `EscrowConfig`

Hesap: `GYEria4Fw3CNDyWkRy28krZmMvZnk5iHbnV5n6pi9cNt`

| Alan | Değer |
| --- | --- |
| admin | `2Ugv8pWJ91mERfavMksgP63ukNMVj4RnCZqtyqKTxct8` |
| settlement_mint | `7TuA1E4nPzN7HNdqCLykHkQWZxMUhdMr3noSqFnwnbdP` |
| registry_program | `CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc` |
| policy_program | `FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU` |
| verifier_program | `AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU` |
| arbitrators | `7Ks2BhbCsknfTSkokakcNiVrNJ2qDx3rRrPew9YH5JyR, HMDAo4tvFhFydU2sB1guppAS5TF7jYnSvXHPbGZeE5kd, H93zZqQuoJ7X9VQgPT9Rq8mzzZdtsaaDoPvvtYhwKsPB` |
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

Adres: `GDBW6uAdnhs3dbLoU8YJHaQbFXy11cFkc3iHQwPqDmbw` · authority: `GmCDcYodVvCAsdwyDvRuxT3m4rVuFdiXkuhbevGXzHbU`

| # | Girdi | Adres |
| --- | --- | --- |
| 0 | `program:registry` | `CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc` |
| 1 | `program:policy` | `FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU` |
| 2 | `program:verifier` | `AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU` |
| 3 | `program:escrow` | `5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT` |
| 4 | `pda:registryConfig` | `HuuRXScYCvFmzCdvu1k2cvtQ3PtdswK5ZYthuJqNTRmq` |
| 5 | `pda:escrowConfig` | `GYEria4Fw3CNDyWkRy28krZmMvZnk5iHbnV5n6pi9cNt` |
| 6 | `pda:verifierConfig` | `5YznQmuHZx3YhqpYujUupQjrNjau6bATiAmWVK2Cyw3c` |
| 7 | `pda:escrowAuthority` | `8tnoRpukiwu6x1b7z1ustnQAYjyXYDXzxu2EWwcxYwGv` |
| 8 | `settlementMint` | `7TuA1E4nPzN7HNdqCLykHkQWZxMUhdMr3noSqFnwnbdP` |
| 9 | `program:system` | `11111111111111111111111111111111` |
| 10 | `program:token` | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| 11 | `program:token2022` | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 12 | `sysvar:instructions` | `Sysvar1nstructions1111111111111111111111111` |

### Init işlemleri

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| init | `init_registry_config` | `3YdrTcyjnqdvtSoyDH5nHmLb2PZLLYr2HttMk5LQPy3krmQjuwj83FquPBQe9J9R2tUUhgzFYzBj6ZKEnP1M9WBq` | 11 377 | varsayılan | 10 203 | 460 | başarılı |
| init | `init_verifier_config` | `5mnDpqesUoxWZjjX8h5r61B4wmsByqVHXqoPUQrmzCBKaHLsEWgjeDqfP94jct6wHRXRbXdxwDWUi7qYbfe7GG7z` | 11 713 | varsayılan | 10 203 | 516 | başarılı |
| init | `init_config` | `4jLLz1Cb4vy8rG1nntda6vjeShmCAv2A1h4UdT1sBcqSwXvqWnL8ZtytogfZSE82MTk5VWFXebJCjqUr8ynsVZLP` | 15 125 | varsayılan | 10 203 | 702 | başarılı |
| ALT | `createLookupTable` + `extendLookupTable` | `3jXP5svCFznruwx1ZyoZQuvsy8mmA1ATt6fMPiPMt6rrE15nfjEh2QB5nyTrh9L9nK3XRkmFo1K2w9vayF5hzEyP` | 20 109 | varsayılan | 5 000 | 688 | başarılı |
