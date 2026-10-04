# Covenant yeniden lisanslama kaydı (BC-03)

Covenant'ın (`wienerlabs/covenant`) kök `LICENSE`'ı ve `app/` dizini LGPL-2.1'dir. Taşınan Covenant
kodunun bu repoda Apache-2.0 altında kullanılabilmesi için katkıcıların onayı aşağıda kayıtlıdır
([§12.5](../../analysis/square-solana-analysis.md#125-lisans),
[ADR 0005](../../decisions/0005-lisans-apache-2-0-ve-notice.md), #3).

## Beyan metni

> Ben, `<GitHub kullanıcı adı>`, `wienerlabs/covenant` deposuna yaptığım tüm katkıların, LGPL-2.1'e ek
> olarak Apache License 2.0 altında da lisanslanmasını ve `wienerlabs/square-solana` deposunda
> Apache-2.0 altında kullanılmasını, değiştirilmesini ve dağıtılmasını kabul ediyorum.

## Kapsam

Taşınan Covenant kodu: `programs/covenant` → `programs/square-escrow` (BC-04, #4). Bu dizinin
yazarları kh0ra ve mehmethayirli'dir. Katkıcı listesi Covenant'ın tam geçmişinden çıkarıldı
(`git shortlog -sne --all`, HEAD `9894a41`).

## Onaylar

| Katkıcı | Commit | Katkının yeri | Onay |
|---|---|---|---|
| kh0ra (`0raclus`, `kh0ra`, `Andrey Markov`) | 278 | `programs/covenant` (neredeyse tamamı), `app/` | Sözlü; 2026-10-04'te MuhammedAkinci'ye verildi. Yazılı kaydı yok |
| mehmethayirli (`Mehmet {zk}`, `0dinantes`) | 21 | `programs/covenant`, `app/` | Yazılı, 2026-10-04: [#3 yorumu](https://github.com/wienerlabs/square-solana/issues/3#issuecomment-5975001035) |
| MuhammedAkinci (`Makinci`) | 1 | `.github/notify/*`, telegram-notify iş akışı | Taşınan koda katkısı yok; onay gerekmiyor |
| virjilakrum (`virjiλ`) | 1 | `README.md`'den 1 satır silme | Taşınan koda katkısı yok; onay gerekmiyor |
| sravan27 | 1 | `0491af6`: `app/lib/webhooks.ts`, `app/app/integrate/page.tsx`, `app/tests/unit/webhooks.test.ts` | Onay alınmadı; aşağıdaki karar geçerli |

## sravan27 kararı

`0491af6` yalnızca Covenant'ın `app/` dizinindedir ve bu dizin Square'e taşınmaz. Bu commit'in içeriği
kullanılmaz; webhook replay koruması BE-13'te (#46) sıfırdan yazılır (clean-room).
