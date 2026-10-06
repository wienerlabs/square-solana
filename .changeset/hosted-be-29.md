---
'@squaresdk/solana-hosted': minor
---

Konfigürasyondan çalışan kurum agent'ı (BE-29), ilk sürüm.

`square-hosted --config <dosya>` YAML ya da JSON yapılandırmasını zod şemasıyla doğrular; geçersiz yapılandırma ya da
politika açılışta reddedilir. Yapılandırma şunları tanımlar: agent kimliği ve kaydı, zincir, MCP sunucuları,
capability'ler (talimat, model, izinli MCP tool'ları, fiyat, zaman / token / eşzamanlılık sınırları), delegasyon ve
duty'ler.

- **Capability çalıştırma:** Her capability, `@squaresdk/solana-agent-sdk` üzerinden gelen işi Claude tool döngüsüyle
  yürütür. Claude yalnızca allowlist'teki MCP tool'larını görür (capability başına ayrı `McpClientPool`); liste dışı
  çağrı sunucuya gitmez. Çıktı teslimat olarak yüklenir. Eşzamanlılık ve kuyruk sınırı `accept_job`'dan önce
  denetlenir: yer yoksa görev reddedilir, kabul edilmiş iş yer bekler ve düşmez.
- **Delegasyon (`square_delegate_job`):** Başka agent'lara `create_job`, gerekirse `commit_travel_rule` ve `fund_job`
  gönderir. Kurumun yerel politika belgesi (`normalizePolicy`, ret bitleri) uygulanır: işlem başı ve günlük tavanlar,
  mint, payee, kategori, zaman penceresi ve izinli agent'lar. Aşan istek tx kurulmadan reddedilir. Tx'ler yerel
  keypair'le imzalanır ya da imzasız dışa verilir. Eşik üstü işte Travel Rule kaydı Square API'sinde (BE-23) kurumun
  oturumuyla saklanır; zincire API'nin döndürdüğü commitment bağlanır, defterde kişisel veri tutulmaz.
- **Duty'ler:** Yalnızca kurumun job'larında çalışır. `policyWatch` (`watchJobProof` ile ispat bağlama) ve `crank`
  (`execute_resolution`, `lapse_dispute`).
- **İzolasyon:** Capability başına süreç içi çalıştırma bağlamı (ADR 0022).
