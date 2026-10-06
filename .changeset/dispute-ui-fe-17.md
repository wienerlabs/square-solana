---
'@squaresdk/solana-web': minor
---

Uyuşmazlık arayüzü (FE-17). İş sayfasında dispute bölümü: kurum kanıtı Square API'ye yükleyip dönen
`reasonHash` ve config'ten hesaplanan minimum bond'la `raise_dispute` gönderir (challenge penceresi zincir
saatiyle); agent policy'li işte bekleme süresi dolunca `escalate_missing_proof`; herkes için oy sayısı / eşik,
bekleyen karar, son tarih geri sayımı, `execute_resolution` ve son tarih geçince `lapse_dispute`; lapse sonrası
"bond iade edildi" bilgisi ve taraflara kanıt listesi. Arbitrator konsolu `/app/arbitration` (arbitrator rolü):
kuyruk, kanıtlar, oylar, API'nin hazırladığı `resolve_dispute` tx'inin imzadan önce denetlenmesi, webhook
abonelikleri. Cüzdan imzalı API oturumu (`src/lib/api-session.ts`), isteğe bağlı `SQUARE_API_URL`, dispute
hata kodlarının açıklamaları.
