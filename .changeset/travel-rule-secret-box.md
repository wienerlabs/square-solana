---
'@squaresdk/solana-api': patch
'@squaresdk/solana-db': minor
---

Travel Rule şifrelemesi `@squaresdk/solana-hardening`'in `SecretBox`'ına geçti (BE-23, ADR 0017). API'nin kendi AES-GCM ve anahtar halkası kodu kaldırıldı; `API_TRAVEL_RULE_KEYS` hardening'in `parseSecretBoxKeys` kurallarıyla doğrulanır. Zarf yapısı aynı: kayda özgü veri anahtarı, ana anahtarla sarma, yeniden sarma. `travel_rule_records`'ta şifreli kayıt ve sarılmış anahtar `SecretBox` değeri (metin); `iv` ve `algorithm` sütunları kaldırıldı. Eski biçimde şifreli satır varsa migration durur. HTTP yüzeyi değişmedi.
