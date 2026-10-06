---
'@squaresdk/solana-web': minor
---

Travel Rule formu ve durumu (FE-18). Eşik üstündeki işte sihirbaz ve iş sayfası originator ve beneficiary
bilgisini ortak `TravelRuleRecord` biçiminde alır; kayıt Square API'sinde şifreli saklanır (BE-23,
`PUT /v1/jobs/{job}/travel-rule`), API'nin döndürdüğü commitment `commit_travel_rule` ile bağlanır. Fonlama,
zincirdeki commitment API'deki kaydın salt'ı ve içeriğinden tarayıcıda yeniden hesaplananla eşleşmeden kapalıdır.
İş sayfasında Travel Rule durumu ve saklanan kayıtla doğrulama.
