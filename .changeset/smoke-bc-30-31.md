---
'@squaresdk/solana-smoke': minor
---

Küme kurulumu ve uçtan uca smoke (BC-30, BC-31): `init` config'leri (registry, verifier, escrow) kurar; upgrade authority Squads vault'uysa talimatları göndermez, Squads'a girilecek biçimde yazar. Square ALT'ını açar ya da doğrular, config'leri zincirden okuyup kayıt satırlarını üretir. `smoke` 8 adımı, ispat-ret ve ispat-yok varyantlarını gerçek işlemlerle koşar; her tx'in imzası, CU'su ve ücreti `docs/deploy/smoke-<küme>.md`'ye yazılır. `smoke:localnet` geçici bir `solana-test-validator`'da ikisini birlikte koşar.
