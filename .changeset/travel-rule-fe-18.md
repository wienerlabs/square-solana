---
'@squaresdk/solana-web': minor
---

Travel Rule formu ve durumu (FE-18). Eşik üstündeki işte sihirbaz ve iş sayfası originator ve beneficiary
bilgisini (IVMS 101 asgarisi) alır, kaydı ve salt'ı tarayıcıda parolayla şifreli saklar (PBKDF2-SHA-256,
AES-256-GCM), commitment'ı SDK ile hesaplayıp `commit_travel_rule` ile bağlar; zincirdeki commitment yerel
kayıtla eşleşmeden fonlama kapalıdır. İş sayfasında Travel Rule durumu ve yerel kayıtla doğrulama.
