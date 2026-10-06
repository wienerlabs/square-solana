# CLI devnet kabul koşusu (BE-30)

**Issue:** BE-30 (#89) · **Araç:** [`squaresdk-solana`](../cli.md) ([`packages/cli`](../../packages/cli/)) ·
**Karar:** [ADR 0025](../decisions/0025-cli-komut-adi-ve-yapilandirma.md)

Akışın 8 adımı devnet'te yalnızca CLI komutlarıyla koşuldu. Her satır bir komut ve onun gönderdiği tx'tir.

| Alan | Değer |
|---|---|
| Tarih (UTC) | 2026-10-06 |
| Commit | `c9d409d` (`feat/be-30-cli`) |
| Koşu | `be30-20261006233055` |
| Küme | devnet, `https://api.devnet.solana.com`; öncelik ücreti 1 000 micro-lamport / CU; Square ALT `3cjUqPz9…` |
| Programlar | [deploy kaydındaki](devnet.md) v0.7.0 (BC-37) |
| Ücret ödeyen | deployer `3qJFqe1Y…` (`--fee-payer`); rol anahtarları yalnızca kendi talimatlarını imzalar |
| Prover | `apps/prover` yerelde (`POST /v1/prove`, `x-api-key`), artefakt `008adfb1…` (devnet verifier'ının gömülü anahtarı) |

## Roller

| Rol | Adres |
|---|---|
| Kurum (imzacı) | `7xNWRmEbp5aQFQuL1vAnJAW3iZn6NXA3CisMSAmnXoi4` |
| Kurum (`Institution` PDA) | `D63bxx4kE8SV2J69AewnitGVLNY5QUXw5RfkUKWSag37` |
| Agent (sahip ve cüzdan) | `C6iFdvJpk2bbFKTseNGhgdKuPZjWpV762b5wuW7AX1z4` |
| Alıcı | `H19475gyJzskjycpACL1LbWfM3UYGGjqCasm6KvmgKZh` |
| Keeper | `GCKxtmGgPSNMV4w38Mhz6gVUhiM2kbaVG6QXjqrKHuCh` |

Politika (belge kurumda kalır; zincirde commitment ve public tavan): `policyId` `8c70cbaa62ff49ba872e803ba4d2635586fb9e7d7dc8fa8050f85f28a20668e2`,
public günlük tavan 100 USDC, gizli günlük tavan 50 USDC, işlem başı 10 USDC, mint devnet USDC, kategori `research`,
her gün 00–23 UTC.

## Adımlar

| # | Rol | Komut | İmza | Zincirden |
|---|---|---|---|---|
| 1 | Kurum | `policy secret`, `policy commit` | `44a4s3Ck6mRgaTKpEqSEzGtad1XkmNW8mrXiUN7XwkjWSubqQBg5Bewx5dds3DicWcVkEXJ1p6eWHcVkV41dwGGP` | `Policy` `5idW2uWTehU12r7VuvVyJNEcXazsMVyfsBPL6kw2st7J`, commitment `0b3ea13a5e5a9178bd35838655585de622b0edea82ee4fcf850d2d5154fc260f`, sürüm 1 (kurum `D63bxx4k…` BC-36'da açılmıştı) |
| 2 | Agent | `agent register` | `3WQ5x1wvzBmCL7op9DMY5BM6E9Lj4xZKVJmFzaHyUKSnuSWCxiqYG8QWF6NPsr1HQd6y3taD3SE8KJ8dJSG6iGTv` | `AgentRecord` `3vr5eQXmTA9Lpy7EDkUeG9EWbQkAJjdLBeVwo3uTNRBX` |
| 2 | — | `agent resolve` | — | DID belgesi çözüldü, uyarı yok; kart yok (`agentCardHash` sıfır) |
| 3 | Kurum | `job create` (politikalı) | `KRT1uRSD3v5aR4q41JPQTE2nsN6RbBdF3awuneEqc5oUsXTRSzFQkv7gVxb3RpCnuFr4HZG8uVJkxGZkbU7t3oN` | job `7Y7Z3BDsRdEDCbWykKCbX3bMbFTnTgju7MtU6BVNFo4F`, 1 USDC, challenge 60 s |
| 3 | Kurum | `job fund` | `2JHDxNEj95fiqQtyeyGvtC5cAPxVFW6gGePJwGiVttdzJwms5J1eEeNvkpuyxbBMFy5RyrWDrsyrTx2iYBnkKTk5` | vault 1 USDC |
| 4 | Agent | `job accept` | `3UiDR4PpXa3Qsi3o6iZ5GQ1NJnjFTS3VGsqXBYbE1bGxpSizmCzDx7sP2s5S6Z8EtKNqioaoHdttGEZBWLzqromB` |  |
| 4 | Agent | `job submit` | `3o1NZApSWCqhxSNaSckRha2WyiWXiW3HoRmm27fHCx95491qye9NVnvNFzWNa3LhvnhgC9Gvw3scVgQembpBvVBH` | iş hash'i `4ac74edf91ce79ee5bf3ddad57b278d6aa396dd892089baac6a96c92a6bdbde0` |
| 5 | Kurum | `policy buyers` | `2wKCH1hH7vzTxbJfdjh2rKyFtHGe9HAAS3tm8x6wNbbHLHSXufy3hnqzgi4ztdwAu4m3P2H4ncrmexFiCBKLFGUf` | alıcı kökü `4459e0a92b878323e8360feb963dcdea66d0fbfce36e2071690f011222668ae2` (1 alıcı) |
| 5 | Agent | `claim list` | `AaSPU8CM94hfSSjgc7NPMSQySQaJqwgUUojwY6fCHsXN6UNSwHLhLvUMrkLz8kzSG2kBHFcHhpwNPSCK8xxxoQz` | fiyat 0,9 USDC |
| 5 | Alıcı | `claim buy` | `mt6apmvjAAXXjm9y3B9kKu4wPxzKqnH79wSbBoXgVXojPqQf1Qi1Hu1g1ASgc4qjhDiGjc1HjLhgutnmkU35SPj` | Merkle kanıtı `policy buyers`'ın dosyasından; payee alıcı |
| 7 | Kurum | `proof bind` | `5JCUyEUV5MJc4SRtJi8BXLUjZpWRdSoCZbzbn71oh9jGb3ZVqNFDoZ1eKvrVxMRwfQvQcvpCZV2dSWTsb1h6UcRX` | `ReleaseProof` `HEE59xr5TiwWk5QKY3xrX86rt1fNyhnxmHaNZTBe4PQ6`: uyumlu, ret kodu 0, payee alıcı, net 995 000 |
| 6 + 8 | Keeper | `job finalize` | `kaTxxP7qrUt6NpiTd2AxHXSgZsJAR5TBewiSQfhPAGkFM9uPDVw5B9HHSRgAQUrVkxVjsaeoyHaXfWZ5KReZQus` | job `Released`; alıcıya net 0,995 USDC, keeper ücreti 0,005 USDC |

- **Screening (adım 3):** Kurumun, agent'ın ve alıcının kaydı screener servisinin (BE-16) kaydıdır; üçü de temiz,
  geçerlilik sonu 2026-11-05. CLI'nin `screening record` komutu screener authority'nin anahtarıyla aynı talimatı
  gönderir. Kayıt kanıt belgesinin hash'ini taşıdığı için koşuda kanıtsız yeniden yazılmadı.
- **Finalize'ın ön denetimi:** Challenge penceresi kapanmadan çalıştırılan `job finalize` tx göndermeden
  `challenge penceresi zincir saatiyle 2026-10-06T23:32:10.000Z'de kapanır (49 s)` ile döndü; pencere kapanınca
  aynı komut işi kapattı.
- **Alıcının bakiyesi:** satın almadan önce 1,38 USDC; fiyat 0,9 USDC ödendi, finalize net 0,995 USDC'yi alıcıya
  ödedi; sonra 1,475 USDC.
- **İlk koşu:** Aynı akış bu commit'ten önceki çalışma ağacıyla da koşuldu (job `HTwnRczR…`, `Released`). O koşuda
  erken finalize program hatası olarak döndü (`escrow programı hatası 6008 challengePeriodNotExpired`); bu, ön
  denetimin eklenme sebebidir.

## Yeniden koşmak

```bash
pnpm --filter @squaresdk/solana-cli build
export SQUARESDK_SOLANA_CONFIG=<yapılandırma.json>         # keypair, feePayer, prover (docs/cli.md)
export SQUARESDK_SOLANA_PROVER_API_KEY=<anahtar>
squaresdk-solana policy secret --out policy-secret
squaresdk-solana policy commit --policy policy.json --secret policy-secret
squaresdk-solana agent register --keypair agent.json --id <agent_id>
squaresdk-solana job create --agent-record <kayıt> --policy <politika> --spec spec.json --amount 1000000 \
  --deadline +7200 --challenge-period 60
squaresdk-solana job fund --job <job>
squaresdk-solana job accept --keypair agent.json --job <job>
squaresdk-solana job submit --keypair agent.json --job <job> --work work.txt --delivery-uri <uri>
squaresdk-solana policy buyers --policy policy.json --secret policy-secret --buyer <alıcı> --out buyers.json
squaresdk-solana claim list --keypair agent.json --job <job> --price 900000
squaresdk-solana claim buy --keypair buyer.json --job <job> --price 900000 --buyers buyers.json
squaresdk-solana proof bind --job <job> --policy policy.json --secret policy-secret --category research
squaresdk-solana job finalize --keypair keeper.json --job <job>
```
