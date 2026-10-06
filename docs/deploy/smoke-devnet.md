# Smoke raporu: devnet

**Issue:** BC-31 (#43) · **Üreten:** [`tests/smoke`](../../tests/smoke/)

| Alan | Değer |
| --- | --- |
| Küme | devnet |
| RPC | `api.devnet.solana.com` |
| Başlangıç (UTC) | 2026-10-06T20:30:47Z |
| Bitiş (UTC) | 2026-10-06T20:35:14Z |
| Commit | `8fbc7ccc5d5d77b61c4fd8c3c6a0f68f4fb36d7f +değişiklik` |
| Koşu | `20261006203047-45ad` |
| Program kimlikleri | registry `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9`, policy `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4`, verifier `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh`, escrow `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` |
| Settlement mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 ondalık) |
| Square ALT | `3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG` |
| İş tutarı | 1 000 000 (1.000000) |
| Alacak fiyatı | 900 000 (0.900000) |
| Keeper ücreti | 50 bps → 5 000 (0.005000) |
| Challenge süresi | 60 s |
| Öncelik ücreti | 1000 micro-lamport / CU |

## Roller

| Rol | Adres |
| --- | --- |
| payer (ücret, rent) | `3qJFqe1YCEteR4mo6X325vUo5ePFmpPYmV6fhD4uSZUC` |
| screener authority | `48DGxja6FefZHhZ8e5ynLKWLqxb1pVfiHFUVg1Jrm54b` |
| kurum (imzacı cüzdan) | `7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4` |
| kurum (`Institution` PDA) | `D63bxx4kE8SV2J69AewnitGVLNY5QUXw5RfkUKWSag37` |
| agent (sahip ve cüzdan) | `C6iFdvJpk2bbFKTseNGhgdKuPZjWpV762b5wuW7AX1z4` |
| alıcı | `H19475gyJzskjycpACL1LbWfM3UYGGjqCasm6KvmgKZh` |
| keeper | `GCKxtmGgPSNMV4w38Mhz6gVUhiM2kbaVG6QXjqrKHuCh` |

## Özet

| Bölüm | Tx | CU | Ücret (lamport) |
| --- | --- | --- | --- |
| Hazırlık | 1 | 9 087 | 5 203 |
| 8 adım | 13 | 424 516 | 126 170 |
| Varyant: ispat-ret (kesin ret → iade) | 7 | 347 522 | 65 830 |
| Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir) | 7 | 374 648 | 60 990 |
| **Toplam** | 28 | 1 155 773 | 258 193 |

## Hazırlık

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | keeper'ın ATA'sı (idempotent) | [`EXbvfCmAA2m3S8R2iD3DwLBFRy3cJAWTKNbffLWoDYS6tbRnUKinW4X33X4DvDrUZeWMqBwBsys7ntc7EPahypj`](https://explorer.solana.com/tx/EXbvfCmAA2m3S8R2iD3DwLBFRy3cJAWTKNbffLWoDYS6tbRnUKinW4X33X4DvDrUZeWMqBwBsys7ntc7EPahypj?cluster=devnet) | 9 087 | varsayılan | 5 203 | 323 | başarılı |

## 8 adım

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `setPolicy` + `setBuyerRoot` | [`fXCE6iD11uTPPBRH7E4ShNnXtiDj7eKxjYxyWGtzJYP1zrmJpd5tRX5ctQAsWxxNq7wnpuR6ogATFzA3BMxwNvp`](https://explorer.solana.com/tx/fXCE6iD11uTPPBRH7E4ShNnXtiDj7eKxjYxyWGtzJYP1zrmJpd5tRX5ctQAsWxxNq7wnpuR6ogATFzA3BMxwNvp?cluster=devnet) | 18 885 | 60 000 | 10 060 | 549 | başarılı |
| 2 | `registerAgent` | [`2EccJChcRkKjDzTWoBQbTKYGtDzMbkuGPaaNs7if81Uc5bdUvJXvYFg2mVyNFcb7Z74aFMxAUY2p2NGQ5767TQ8a`](https://explorer.solana.com/tx/2EccJChcRkKjDzTWoBQbTKYGtDzMbkuGPaaNs7if81Uc5bdUvJXvYFg2mVyNFcb7Z74aFMxAUY2p2NGQ5767TQ8a?cluster=devnet) | 9 804 | 40 000 | 10 040 | 495 | başarılı |
| 3 | `recordScreening` (kurum) | [`3fV8p2CiMVXNdKx94vvhzC79SBXXM4caZ4gbTXVzz3nLszdH9uTtCrbe8d1FUbtcqSY3QWSC9NDPNL2SryVZquQ1`](https://explorer.solana.com/tx/3fV8p2CiMVXNdKx94vvhzC79SBXXM4caZ4gbTXVzz3nLszdH9uTtCrbe8d1FUbtcqSY3QWSC9NDPNL2SryVZquQ1?cluster=devnet) | 8 509 | 40 000 | 10 040 | 465 | başarılı |
| 3 | `recordScreening` (agent) | [`3FUgTHYufUZREJS6XtFW9gj1RXb3vPdzRf7egx5jHw5kEhaZmDopq1AJpbvyNiwWxCDqrv9Duibdc4dN5aqJAWdM`](https://explorer.solana.com/tx/3FUgTHYufUZREJS6XtFW9gj1RXb3vPdzRf7egx5jHw5kEhaZmDopq1AJpbvyNiwWxCDqrv9Duibdc4dN5aqJAWdM?cluster=devnet) | 8 509 | 40 000 | 10 040 | 465 | başarılı |
| 3 | `recordScreening` (alıcı) | [`4nJDFpEACrrCMYymg3rcDDzhN2UYoLrzW2qtNYfijxDDxLno5LEcL3jw1FRDDSrqvYPKi8vorYTZwM6QsGCbTuT9`](https://explorer.solana.com/tx/4nJDFpEACrrCMYymg3rcDDzhN2UYoLrzW2qtNYfijxDDxLno5LEcL3jw1FRDDSrqvYPKi8vorYTZwM6QsGCbTuT9?cluster=devnet) | 10 009 | 40 000 | 10 040 | 465 | başarılı |
| 3 | `createJob` (politikalı) | [`QPat3pdmSe9hHChqqygQZM8qoRQd1mTfvyi464vjVyK7c34AwCdD8Cj5zRFeHGpg6xx4ndTGfzxnARMxhkydoqi`](https://explorer.solana.com/tx/QPat3pdmSe9hHChqqygQZM8qoRQd1mTfvyi464vjVyK7c34AwCdD8Cj5zRFeHGpg6xx4ndTGfzxnARMxhkydoqi?cluster=devnet) | 29 610 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | [`41kFaArixaFZ1jFUgE7jvaxUQFX5MLmmK3fZSQ2QCtfUUSHhrAE7sXJtL62TXLr8C2aM2RNc1ErDGtRUTrMyrrhh`](https://explorer.solana.com/tx/41kFaArixaFZ1jFUgE7jvaxUQFX5MLmmK3fZSQ2QCtfUUSHhrAE7sXJtL62TXLr8C2aM2RNc1ErDGtRUTrMyrrhh?cluster=devnet) | 23 541 | 90 000 | 10 090 | 533 | başarılı |
| 4 | `acceptJob` | [`2ixYdNrLuAwUkVB1ZwVm2cTeTG9jZpnS4fdNfJiSK3cRC8uo7RGzZFTVFHEuRaMb6kpqHaWstF5wq9uKLtxRRvtc`](https://explorer.solana.com/tx/2ixYdNrLuAwUkVB1ZwVm2cTeTG9jZpnS4fdNfJiSK3cRC8uo7RGzZFTVFHEuRaMb6kpqHaWstF5wq9uKLtxRRvtc?cluster=devnet) | 7 821 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | [`5Zfh852BfWMPyVLWoCcZcccy86zxCe6NoPT73KKoRgpwiLXQ3uJe5deAjS56ufynso3hYo3AFkBF29Sm45dqiRhn`](https://explorer.solana.com/tx/5Zfh852BfWMPyVLWoCcZcccy86zxCe6NoPT73KKoRgpwiLXQ3uJe5deAjS56ufynso3hYo3AFkBF29Sm45dqiRhn?cluster=devnet) | 8 374 | 20 000 | 10 020 | 477 | başarılı |
| 5 | `listClaim` | [`4Hanin7Uk9mHcW6sei1HWYnuCRoFNfYWRMwrVq73gbujpJHkhjv2kXMQ8FfP9oj4Shwsr5TpdtA8Lk9BiL9qbaSi`](https://explorer.solana.com/tx/4Hanin7Uk9mHcW6sei1HWYnuCRoFNfYWRMwrVq73gbujpJHkhjv2kXMQ8FfP9oj4Shwsr5TpdtA8Lk9BiL9qbaSi?cluster=devnet) | 11 360 | 50 000 | 10 050 | 439 | başarılı |
| 5 | `buyClaim` (Merkle kanıtlı) | [`4BeXmBieupFoz36zuV1sPzejJYVNSmoimXMhqZLV6u2y3bnrxD3bwRvQ2tEmp36TA1Wbh3WLrNqFcq3KJyX256ns`](https://explorer.solana.com/tx/4BeXmBieupFoz36zuV1sPzejJYVNSmoimXMhqZLV6u2y3bnrxD3bwRvQ2tEmp36TA1Wbh3WLrNqFcq3KJyX256ns?cluster=devnet) | 32 755 | 110 000 | 10 110 | 685 | başarılı |
| 7 | `setComplianceProof` (Groth16) | [`5G4N8TuK3AiRRKFoMHBRxqBijYcDB37NWYe9n5kyz7LkmquHQxR5GdiPDPB7Lpd6TTPuU2Ab7dq1x3QKrXEQ4NTm`](https://explorer.solana.com/tx/5G4N8TuK3AiRRKFoMHBRxqBijYcDB37NWYe9n5kyz7LkmquHQxR5GdiPDPB7Lpd6TTPuU2Ab7dq1x3QKrXEQ4NTm?cluster=devnet) | 177 226 | 360 000 | 10 360 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | [`ysDvndkuy4HH3dSys8PjKKgdPF16Sr7DBWFSSAvMvQsMjZ8GUnHEVLzPCdcbq2ZcrcuY3jY5C9GhjdoLdfPGgML`](https://explorer.solana.com/tx/ysDvndkuy4HH3dSys8PjKKgdPF16Sr7DBWFSSAvMvQsMjZ8GUnHEVLzPCdcbq2ZcrcuY3jY5C9GhjdoLdfPGgML?cluster=devnet) | 78 113 | 200 000 | 5 200 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `Ea9U8Bap4aeaqLsY7rS6jokzQJKpeaztAsiC6JfzomYn` | compliant | 0 | 830 |

Zincirden doğrulananlar:

- `Policy` 9jaQTzHZhM3GwPkyGdmakVBTBDR4dKBVK5tRNyxraJrM: commitment yerel politikayla aynı, public tavan 1 000 000 000, sürüm 1, aktif
- alıcı kökü b0f3a999a788a97e83c32e315cbd02f161433ef38c7f0c5a2708fd92c1898275 (1 onaylı alıcı)
- `AgentRecord` EzHfJEnR2yutTi82MGKtpuBmRvV4ETMaP6CoLj7kUjEg (`smoke-20261006203047-45ad`): cüzdan agent, durum aktif
- kurum screening'i temiz; geçerlilik sonu 2026-11-05T20:31:00Z
- agent screening'i temiz; geçerlilik sonu 2026-11-05T20:31:01Z
- alıcı screening'i temiz; geçerlilik sonu 2026-11-05T20:31:03Z
- job Ea9U8Bap4aeaqLsY7rS6jokzQJKpeaztAsiC6JfzomYn fonlandı: vault 1 000 000 (1.000000)
- job teslim edildi; challenge sonu 2026-10-06T20:32:20Z
- alacak alıcıya satıldı; payee artık alıcı
- agent fiyatı aldı: 900 000 (0.900000)
- `ReleaseProof`: uyumlu, payee alıcı, net 995 000 (0.995000)
- job `Released`
- alıcıya ödendi: 995 000 (0.995000)
- keeper ücreti: 5 000 (0.005000) (50 bps)
- itibar (`AgentReputation`): tamamlanan iş 1, kazanç +995 000 (0.995000)
- `ValidationRecord`: `Verified`, ispata bağlı
- alacak listelemesi `Settled`
- `ReleaseProof` tüketildi (`record_release` CPI)

## Varyant: ispat-ret (kesin ret → iade)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `setPolicy` (işlem başı tavan 1) | [`3VVyovXaJpn7eaE9f1m3ukJ7AUwZmEcRKQQti645T2J7gZYofYQYzDWJ1oW4D9GLa2PvLv6fs1rrwrBzwWt5wX5R`](https://explorer.solana.com/tx/3VVyovXaJpn7eaE9f1m3ukJ7AUwZmEcRKQQti645T2J7gZYofYQYzDWJ1oW4D9GLa2PvLv6fs1rrwrBzwWt5wX5R?cluster=devnet) | 13 324 | 40 000 | 10 040 | 503 | başarılı |
| 3 | `createJob` (politikalı) | [`3ZBAh4irEUmtzRNWVVUeqQUYkANpheNCFu6XZTwRTgjHPjc9178TUH2ecEDdookx6Nvmou6EEhBU9PNenE8yHD22`](https://explorer.solana.com/tx/3ZBAh4irEUmtzRNWVVUeqQUYkANpheNCFu6XZTwRTgjHPjc9178TUH2ecEDdookx6Nvmou6EEhBU9PNenE8yHD22?cluster=devnet) | 32 610 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | [`55jk2qL92R4BKV9SotvogWRLjYhdLZf3EpMqHzfGgTWsTCcrs5WRj3VpHSQv6gJdzwP3RcmvQYSzhprNycVeMbGn`](https://explorer.solana.com/tx/55jk2qL92R4BKV9SotvogWRLjYhdLZf3EpMqHzfGgTWsTCcrs5WRj3VpHSQv6gJdzwP3RcmvQYSzhprNycVeMbGn?cluster=devnet) | 23 558 | 90 000 | 10 090 | 533 | başarılı |
| 4 | `acceptJob` | [`3Jis2GPha43LBaYYAA1HqHVxua5qWV8BnT72HzwdjDhAUNG8RiKbgyZfiA7ZgxwA2WsWD8wHc2PQDHEVncBsTLoy`](https://explorer.solana.com/tx/3Jis2GPha43LBaYYAA1HqHVxua5qWV8BnT72HzwdjDhAUNG8RiKbgyZfiA7ZgxwA2WsWD8wHc2PQDHEVncBsTLoy?cluster=devnet) | 7 821 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | [`5twyNfUn7rEwAaaCMWjpL493Xo3E3iy2dYerP3vFbqcyFMoWdsgKMwFnMnhGMX5idq6nU3t9pbbar8iWr5MA1ipH`](https://explorer.solana.com/tx/5twyNfUn7rEwAaaCMWjpL493Xo3E3iy2dYerP3vFbqcyFMoWdsgKMwFnMnhGMX5idq6nU3t9pbbar8iWr5MA1ipH?cluster=devnet) | 8 329 | 20 000 | 10 020 | 476 | başarılı |
| 7 | `setComplianceProof` (Groth16) | [`2zeDw71A9jT7WUiFv338FWtDuoMDFCQTxtPvCuYdUNmqNJKSCs9JDmqwGpPNj65XaW4L371zoi11ADQNkipobJ2L`](https://explorer.solana.com/tx/2zeDw71A9jT7WUiFv338FWtDuoMDFCQTxtPvCuYdUNmqNJKSCs9JDmqwGpPNj65XaW4L371zoi11ADQNkipobJ2L?cluster=devnet) | 181 382 | 360 000 | 10 360 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | [`4V6gJkTGWAVPqpyWnAuwobGmg3JBnSMJB3rVmVD5jx3sJNeLbeEm4hKHCUgWj5Ca9EFVMGBriuGn9NGzqct1Zt6W`](https://explorer.solana.com/tx/4V6gJkTGWAVPqpyWnAuwobGmg3JBnSMJB3rVmVD5jx3sJNeLbeEm4hKHCUgWj5Ca9EFVMGBriuGn9NGzqct1Zt6W?cluster=devnet) | 80 498 | 200 000 | 5 200 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `3DmCwjiiAnjsVhpV9HXLormAPfHgtVRmJDD2Aizay8gA` | refused | 1 | 637 |

Zincirden doğrulananlar:

- `Policy` 3cKmgEBeFoSJX58EDUgMUNNhrq1mBwhtAZiprC1xJNMP: commitment yerel politikayla aynı, public tavan 1 000 000 000, sürüm 1, aktif
- job 3DmCwjiiAnjsVhpV9HXLormAPfHgtVRmJDD2Aizay8gA fonlandı: vault 1 000 000 (1.000000)
- job teslim edildi; challenge sonu 2026-10-06T20:33:43Z
- `ReleaseProof`: ret, kod 1 (perTx), kesin ret
- job `Refunded`
- net kuruma iade edildi: 995 000 (0.995000)
- keeper ücreti yine ödendi: 5 000 (0.005000)
- `ValidationRecord`: `Refused`, ret kodu 1
- itibar: tamamlanan iş ve kazanç değişmedi

## Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir)

| Adım | Tx | İmza | CU | CU sınırı | Ücret (lamport) | Boyut (bayt) | Sonuç |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | `createJob` (politikalı) | [`3HLhiJS3irMAm6XjFPYPuem5WnY12zu9qtbrw9Gg9VP7dFTMckV7GzchxyTxFzsEnnf49MYRWRCmm1rUNHouAxnj`](https://explorer.solana.com/tx/3HLhiJS3irMAm6XjFPYPuem5WnY12zu9qtbrw9Gg9VP7dFTMckV7GzchxyTxFzsEnnf49MYRWRCmm1rUNHouAxnj?cluster=devnet) | 31 110 | 100 000 | 10 100 | 592 | başarılı |
| 3 | `fundJob` | [`b3nYfNrmKcvFh1f8afuvPf96nqWLE5k7kxb9N3avNBPpy9hPPwq8Tih9y2vtaXgsaFjQ756oUVaZWs8MbaRRex2`](https://explorer.solana.com/tx/b3nYfNrmKcvFh1f8afuvPf96nqWLE5k7kxb9N3avNBPpy9hPPwq8Tih9y2vtaXgsaFjQ756oUVaZWs8MbaRRex2?cluster=devnet) | 23 541 | 90 000 | 10 090 | 533 | başarılı |
| 4 | `acceptJob` | [`2uJWvkf4XMkLV8FQKdTwsEgE9tgQZEd32NFBKeReefw3vBMbSaxDiA6BTfdz5T7gmsXqoQkQaifZkHjoSot4a8Se`](https://explorer.solana.com/tx/2uJWvkf4XMkLV8FQKdTwsEgE9tgQZEd32NFBKeReefw3vBMbSaxDiA6BTfdz5T7gmsXqoQkQaifZkHjoSot4a8Se?cluster=devnet) | 7 821 | 20 000 | 10 020 | 426 | başarılı |
| 4 | `submitWork` | [`E3hxJ3UPutb2ZLzBT3g2jEvuM3G9jjA31ATvrTwxowybypWspcui3enaFXCWVQ6wU11xZBGSSeYXPdtaMCEVNVp`](https://explorer.solana.com/tx/E3hxJ3UPutb2ZLzBT3g2jEvuM3G9jjA31ATvrTwxowybypWspcui3enaFXCWVQ6wU11xZBGSSeYXPdtaMCEVNVp?cluster=devnet) | 8 329 | 20 000 | 10 020 | 476 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | [`vszeiAvo3gpmKt5QsQbMeWJAQWAkTmh4hFFzxv6nsPnmxzbGng6bTpm8S29QmX356FpW4J8j9KzxZkA9jVn34x5`](https://explorer.solana.com/tx/vszeiAvo3gpmKt5QsQbMeWJAQWAkTmh4hFFzxv6nsPnmxzbGng6bTpm8S29QmX356FpW4J8j9KzxZkA9jVn34x5?cluster=devnet) | 50 645 | 200 000 | 5 200 | 792 | beklenen ret: `escrow::proofRequired` (6039) |
| 7 | `setComplianceProof` (Groth16) | [`5HfnXf2fh3BfUfnZFvSmvm1AgzUq15987Zfms7vVm8H89tv5HetRNheSc3W4EK4NiD8Jy4yM3jSwPLoqy3b2bJ7o`](https://explorer.solana.com/tx/5HfnXf2fh3BfUfnZFvSmvm1AgzUq15987Zfms7vVm8H89tv5HetRNheSc3W4EK4NiD8Jy4yM3jSwPLoqy3b2bJ7o?cluster=devnet) | 175 379 | 360 000 | 10 360 | 840 | başarılı |
| 6 + 8 | `finalizePayment` (keeper) | [`JQtCKNJfPf9RXRPNk6zqeK6ihnpu2gPHJBVv7hXdu4bs7zdW4Gb1kkXBVdW3VxezCGFBuM4Kgytmj4BTRdArqet`](https://explorer.solana.com/tx/JQtCKNJfPf9RXRPNk6zqeK6ihnpu2gPHJBVv7hXdu4bs7zdW4Gb1kkXBVdW3VxezCGFBuM4Kgytmj4BTRdArqet?cluster=devnet) | 77 823 | 200 000 | 5 200 | 792 | başarılı |

| İspat | Karar | Ret kodu | İspat süresi (ms) |
| --- | --- | --- | --- |
| `F9am3PXneFrwkBY2qAfE6zoQ4HAyddY2uWDqvuJ5MFdN` | compliant | 0 | 681 |

Zincirden doğrulananlar:

- job F9am3PXneFrwkBY2qAfE6zoQ4HAyddY2uWDqvuJ5MFdN fonlandı: vault 1 000 000 (1.000000)
- job teslim edildi; challenge sonu 2026-10-06T20:34:59Z
- finalize `ProofRequired` ile düştü: job `Delivered`, vault 1 000 000 (1.000000) (escrow bekliyor)
- `ReleaseProof` hesabı yok
- `ReleaseProof`: uyumlu, payee agent (alacak satılmadı)
- ispat bağlandıktan sonra job `Released`
- agent'a ödendi: 995 000 (0.995000)
