---
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': minor
---

Verifier `sync_vk_version` (BC-38, program sözleşmesi v0.8.0, API sözleşmesi v0.26.0): doğrulama anahtarı değişen bir upgrade'den sonra config'in `vk_version`'ını programın `RELEASE_VK_VERSION`'ına eşitler; yeni hata 6012 `VkVersionAlreadySynced`. SDK'nın IDL kopyaları ve üretilen şemalar yeniden üretildi (`client.verifier.instructions.syncVkVersion`, OpenAPI `SyncVkVersionCall`). Mevcut talimatlar, hesaplar, event'ler ve kodlar değişmedi.
