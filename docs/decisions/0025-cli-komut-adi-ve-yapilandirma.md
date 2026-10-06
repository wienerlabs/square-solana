# ADR 0025: CLI'nin komut adı, yapılandırması ve ispat üretimi

- **Durum:** Kabul edildi
- **Issue:** BE-30 (#89)
- **Karar kaynağı:** BE-30 iş kalemleri 1 ve 7 ("Komut adı (öneri: `squaresdk-solana`; BE-01 ADR'sinde kesinleşir)",
  "JSON çıktı modu; konfig (cluster, keypair)"); [ADR 0001](0001-ts-paket-adlandirma-ve-surumleme.md) (`square` adı
  kullanılmaz); issue sahibinin yönlendirmesi (2026-10-07): ispat üretimi projeye ve issue'ya en uygun biçimde.
- **Kapsam:** `packages/cli` (`@squaresdk/solana-cli`), [docs/cli.md](../cli.md)

## Bağlam

- ADR 0001 paket adlarını sabitler, komut adını sabitlemez. BE-30 issue'su komut adının bir ADR'de
  kesinleşmesini ister.
- Akışın 7. adımı Groth16 ispatı ister. Yerel prover snarkjs'tir (GPL-3.0). Lisans envanterinde snarkjs yalnızca
  servislerde (apps/prover) ve testlerde kabul edilir; `@squaresdk/solana-policy` snarkjs içermez, ispatı uzak
  prover'dan (`createRemoteProver`) ya da çağıranın verdiği groth16 nesnesinden alır.
- Square API `POST /v1/prove`'u `prove` kapsamlı API anahtarıyla sunar; prover servisi (`apps/prover`) aynı ucu
  `x-api-key` ile sunar. İkisi aynı zarfı döner.

## Karar

1. **Komut adı:** `squaresdk-solana`; npm paketi `@squaresdk/solana-cli`, `bin` girdisi aynı ad. Komutlar
   `<grup> <eylem>` biçimindedir (`job create`, `claim buy`).
2. **Yapılandırma:** Öncelik sırası bayrak, ortam değişkeni (`SQUARESDK_SOLANA_*`), yapılandırma dosyası
   (`--config`, `SQUARESDK_SOLANA_CONFIG` ya da `~/.config/squaresdk-solana/config.json`), varsayılan.
   - Varsayılan küme devnet; RPC kümenin herkese açık adresi; rol anahtarı Solana CLI'nin varsayılanı
     (`~/.config/solana/id.json`).
   - Dosyada sır yoktur: anahtarlar `solana-keygen` dosyalarının yollarıdır. Prover'ın API anahtarı yalnızca
     `SQUARESDK_SOLANA_PROVER_API_KEY` ortam değişkenindedir. Dosya şeması bilinmeyen alanı reddeder.
   - Rol imzacısı (`--keypair`) ile ücret ve rent ödeyen (`--fee-payer`) ayrıdır.
   - Program kimlikleri IDL'lerdeki adreslerdir (BC-09; bütün kümelerde aynı).
3. **Çıktı:** Sonuç standart çıktıya; `--json` ile tek satırlık JSON nesnesi. Hata standart hataya, `--json` ile
   standart çıktıya `{"error"}`. Program hatası `<program> programı hatası <kod> <ad>`. Çıkış kodu 0, 1 ya da 2
   (kullanım hatası).
4. **İspat:** CLI ispatı uzak prover'dan alır (Square API ya da prover servisi). Pakette snarkjs yoktur.
   Beklenen artefakt sürümü (zkey SHA-256) yapılandırmadan gelir; kodda sabit değildir.
5. **Referans:** Komut referansı ([docs/cli.md](../cli.md)) komut tablosundan üretilir ve testte güncelliği
   denetlenir (`packages/cli/scripts/reference.mjs --check`).

## Gerekçe

Bu bölümdeki gerekçeler bu ADR'ındır; kaynaklarda gerekçe yoktur.

- **Madde 1:** `squaresdk-solana` npm kapsamıyla aynı adı taşır ve Arc sürümünün CLI'siyle çakışmaz.
- **Madde 2:** Solana CLI'nin varsayılan anahtarı ve kümeleri, Solana kullanıcısının beklediği davranıştır. Sırların
  dosyada olmaması, yapılandırmanın paylaşılmasını ve depoya girmesini güvenli kılar.
- **Madde 4:** Yayımlanacak pakete GPL-3.0 kod girmez. Kurumun politikası ve sırrı yine kurumda kalır: prover'a
  witness gider, sır gitmez.

## Sonuçlar

- **Uygulama:** `packages/cli/src` (komutlar `commands/`, yapılandırma `config.ts`, gönderim `context.ts`).
- **Testler:** Komutların tx'leri bellekteki zincirde kurulup çözülür; yapılandırma, çıktı ve gönderim ayrı testli.
- **Devnet kabulü:** 8 adım CLI ile devnet'te koşuldu ([deploy/cli-devnet.md](../deploy/cli-devnet.md)).
- **Yerel ispat:** Yerel ispat isteyen kullanıcı `@squaresdk/solana-policy`'nin `createLocalProver`'ını kendi
  kurduğu snarkjs ile programatik olarak kullanır; CLI bunu sunmaz.
