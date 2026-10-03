# ADR 0005: Lisans: Apache-2.0 ve NOTICE

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.5](../analysis/square-solana-analysis.md#125-lisans) (2026-10-02)
- **Kapsam:** tüm repo; `LICENSE`, `NOTICE`, [lisans politikası](../licensing.md), üçüncü taraf
  envanteri, taşınan dizinlerin lisansları

## Bağlam

Hedef repo MIT lisansıyla açılmıştı. Kaynakların lisansları farklıydı: Covenant karışık (kök `LICENSE`
ve `app/` LGPL-2.1, kök `package.json`, `sdk/` ve `mcp/` Apache-2.0), Aperture MIT, AIP için analiz
yalnızca `package.json` ve README'de ISC beyanı buldu
([§5](../analysis/square-solana-analysis.md#5-square-solana-hedef-repo--mevcut-durum)). LGPL-2.1 kod
izin verici bir lisansa sahip repoya girdiğinde dosya bazında LGPL kalır; çevrilmesi için yeniden
lisanslama kararı gerekir (§5; [§10](../analysis/square-solana-analysis.md#10-riskler) R8).

## Karar

1. Repo lisansı Apache-2.0'dır. `NOTICE` dosyası Covenant, Aperture (MIT) ve AIP (ISC) kökenlerini
   belirtir (§12.5'in ifadesi; AIP'nin lisansı için bkz. Sonuçlar). Repodaki MIT `LICENSE` Apache-2.0
   ile değiştirilir.
2. Covenant LGPL kodunun yeniden lisanslanması için kh0ra, mehmethayirli, MuhammedAkinci ve
   virjilakrum'dan yazılı onay alınır.
3. sravan27'nin tek commit'i (`0491af6`, "Harden webhook signatures against replay (#229)") için ya
   onay alınır ya da o parça yeniden yazılır.

## Gerekçe

Yeniden lisanslama ihtiyacı analizde kayıtlıdır (§5, R8). Apache-2.0'ın seçilme gerekçesi analizde
yazılmadı; karar §12.5'tedir. Bağlam olarak analiz şunları kaydeder: Arc'taki Square Apache-2.0 ve
NOTICE ile lisanslıdır ([§4](../analysis/square-solana-analysis.md#4-square-arc--sadece-%C3%B6zellik-kapsam%C4%B1-referans%C4%B1)),
Covenant'ın kök `package.json`, `sdk/` ve `mcp/` dizinleri Apache-2.0'dır (§5).

## Sonuçlar

- Uygulandı (BC-02, #2): `LICENSE` Apache-2.0, `NOTICE`, [lisans politikası](../licensing.md),
  [üçüncü taraf envanteri](../THIRD_PARTY_LICENSES.md) ve CI kapısı (`.github/workflows/license.yml`).
  Taşınan dizinler kaynak `LICENSE` dosyalarını korur.
- AIP'nin lisansı: taşımanın kaynağı olan upstream (`dr-wilson-empty/aip-beta`) MIT `LICENSE` taşır ve
  `NOTICE` AIP'yi MIT olarak kaydeder ([BC-07 provenance](../provenance/BC-07.md)). §12.5'teki "AIP
  (ISC)" ifadesi analiz anındaki `package.json` beyanına dayanır.
- Covenant'ın LGPL kodu onaylar tamamlanana kadar repoya girmez: escrow taşıması (BC-04, #4) BC-03'ü
  (#3) bekler; veri modeli Covenant şemasını bu yüzden kopyalamadı
  ([veri modeli §7](../design/data-model.md#7-kaynaklardan-farklar)).
- sravan27'nin commit'i yalnızca Covenant `app/` altındaki üç dosyaya dokunur (§12.5 tablosu); onay ya
  da yeniden yazım kararı BC-03'te (#3) kaydedilir.

## Açık noktalar

- Yazılı onaylar ve `docs/legal/relicensing/` (BC-03, #3).
- GPL-3.0 lisanslı `snarkjs` ve `circomlibjs` envanterde "inceleme" durumundadır; servis imajları
  dağıtılmadan önce hukuki onay gerekir ([üçüncü taraf envanteri](../THIRD_PARTY_LICENSES.md)).
