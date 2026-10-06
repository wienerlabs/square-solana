---
'@squaresdk/solana-web': minor
---

Uyuşmazlık arayüzü (FE-17). İş sayfasında dispute bölümü: kurum kanıtı Square API'ye yükleyip dönen
`reasonHash` ve config'ten hesaplanan minimum bond'la `raise_dispute` gönderir (challenge penceresi zincir
saatiyle); agent policy'li işte bekleme süresi dolunca `escalate_missing_proof`; herkes için oy sayısı / eşik,
bekleyen karar, son tarih geri sayımı, `execute_resolution` ve son tarih geçince `lapse_dispute`; lapse sonrası
"bond iade edildi" bilgisi ve taraflara kanıt listesi. Arbitrator konsolu `/app/arbitration` (arbitrator rolü):
sayfalı kuyruk, kanıtlar, oylar, API'nin hazırladığı `resolve_dispute` tx'inin imzadan önce denetlenmesi (compute
budget'ta yalnızca birer limit ve fiyat, fiyat en çok 1 000 000 micro-lamport/CU), webhook abonelikleri. API
oturumu FE-03'ün cüzdan imzalı oturumudur (`useApiClient`); dispute hata kodlarının açıklamaları.
