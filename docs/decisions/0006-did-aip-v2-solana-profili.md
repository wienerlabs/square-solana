# ADR 0006: Agent kimliği: `did:aip` v2'nin Solana (CAIP-2) profili

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar), DID
  satırı (2026-10-02)
- **Kapsam:** `square_registry`, `@squaresdk/solana-identity`, agent card, [`docs/did-aip/`](../did-aip/)

## Bağlam

Kaynak projelerde üç DID biçimi vardı: `did:aip:{8char}:{id}`, `did:key:z6Mk…` ve
`did:aip:platform:*`
([§6](../analysis/square-solana-analysis.md#6-square-%C3%B6zelli%C4%9Fi--kaynak-proje-e%C5%9Flemesi),
13. satır; [§7](../analysis/square-solana-analysis.md#7-%C3%B6rt%C3%BC%C5%9Fmeler-ve-%C3%A7ak%C4%B1%C5%9Fmalar),
2. satır). Arc'taki Square `did:aip` v2'yi ERC-8004'e taşıdı; v1 Solana'ya bağlıydı ve v1
tanımlayıcıları resolve edilebilir kaldı
([§4](../analysis/square-solana-analysis.md#4-square-arc--sadece-%C3%B6zellik-kapsam%C4%B1-referans%C4%B1)).
Analiz iki yolu sordu: v1 (Solana) biçimi ya da v2'nin bir Solana profili
([§11](../analysis/square-solana-analysis.md#11-a%C3%A7%C4%B1k-sorular-faz-2ye-ge%C3%A7meden-%C3%B6nce-cevap-gerekiyor--12de-cevapland%C4%B1),
soru 5).

## Karar

1. Kanonik agent kimliği `did:aip` v2 biçiminin Solana (CAIP-2) profilidir.
2. v1 tanımlayıcıları resolve edilebilir kalır.

## Gerekçe

§12 ayrıca gerekçe yazmadı. Analiz, Square-Solana için mantıklı yolun v1'i ya da v2'nin bir Solana
profilini kanonik kimlik olarak almak olduğunu yazdı (§4); ikisi arasındaki tercihin gerekçesini
yazmadı. Profil spesifikasyonu v2 profilinin gerekçesini şöyle verir
([§1.1](../did-aip/method-spec-v2-solana.md#11-why-a-solana-profile)): Square'in programları agent
kimliğine doğrudan başvurur (escrow job'u işi yapan agent'a bağlar; itibar ve validation kayıtları
cüzdana değil agent'a yazılır), bu yüzden çapa Solana'da olmalıdır; tek çözücü sözleşmesi ve tek çapraz
kayıt modeli iki ekosistemi kapsasın diye de v2 biçimi kullanılır.

## Sonuçlar

- Tanımlayıcı `did:aip:solana:{chain-ref}:{registry}:{agent-record}` biçimindedir: chain-ref genesis
  hash'inin ilk 32 karakteri, agent kısmı AgentRecord PDA adresidir. Agent card'ın URI'si ve SHA-256'sı
  zincirdedir ([profil spesifikasyonu](../did-aip/method-spec-v2-solana.md), BC-14 #14).
- Çözücü `@squaresdk/solana-identity`'de uygulandı (BE-09, #41). Registry programının profile uyarlanması
  BC-15'tedir (#24).
- v1 çözümü kullanımdan kalkmış (deprecated) olarak desteklenir (spesifikasyon §9).

## Açık noktalar

- Spesifikasyonun durumu "Draft".
- `packages/agent-sdk` hâlâ v1 biçimini kullanıyor; v2'ye geçiş BE-19'dadır (#52).
- Registry IDL'i BC-09'a (#9) kadar v1 programının kimliğini taşır
  ([ADR 0004](0004-gecmisli-tasima-ve-yeni-program-idleri.md)).
