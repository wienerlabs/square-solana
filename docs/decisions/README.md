# docs/decisions/

Mimari karar kayıtları (ADR). Her karar ayrı bir dosyada, sıra numarasıyla tutulur. Yeni bir ADR
[`sablon.md`](sablon.md)'den başlar.

| ADR | Karar | Issue |
|---|---|---|
| [0001](0001-ts-paket-adlandirma-ve-surumleme.md) | TS paketlerinin adlandırılması (`@squaresdk/solana-*`), sürümleme (changesets) ve yayını | BE-01 (#15) |
| [0002](0002-web-hosting-railway.md) | Web uygulaması da Railway'de; PR preview'ları Railway PR Environments (§12.4'teki Vercel kararının yerine) | BE-37 (#133) |
| [0003](0003-mimari-yol-c-tek-anchor-workspace.md) | Mimari yol C: tek Anchor workspace, account-read öncelikli entegrasyon | BE-06 (#20) |
| [0004](0004-gecmisli-tasima-ve-yeni-program-idleri.md) | Programların geçmişleriyle taşınması ve yeni Square program kimlikleri | BE-06 (#20) |
| [0005](0005-lisans-apache-2-0-ve-notice.md) | Lisans: Apache-2.0 ve NOTICE | BE-06 (#20) |
| [0006](0006-did-aip-v2-solana-profili.md) | Agent kimliği: `did:aip` v2'nin Solana (CAIP-2) profili | BE-06 (#20) |
| [0007](0007-anchor-surumu.md) | Anchor sürümü: en güncel kararlı sürüm, M1'de sabitlenir | BE-06 (#20) |
| [0008](0008-upgrade-authority-2-of-3-squads.md) | Program upgrade authority: 2-of-3 Squads multisig | BE-06 (#20) |
| [0009](0009-tek-postgres-ve-prisma.md) | Veritabanı: tek Postgres ve Prisma | BE-06 (#20) |
| [0010](0010-cuzdan-wallet-adapter-react.md) | Cüzdan bağlantısı: `@solana/wallet-adapter-react` | BE-06 (#20) |
| [0011](0011-monorepo-araclari-pnpm-ve-turborepo.md) | Monorepo araçları: pnpm workspaces ve Turborepo | BE-06 (#20) |
| [0012](0012-ispat-tazeligi-ve-gunluk-sayac.md) | Release ispatının tazeliği ve günlük sayacın yalnızca release'te ilerlemesi | BC-21 (#29) |
| [0013](0013-release-keeper-ucreti-iade-ve-itibar.md) | Release: keeper ücretinin tavanı, yalnızca kalıcı retlerin iade etmesi, payee screening'i, itibar ve validation kaydı | BC-23 (#31), BC-24 (#32), BC-26 (#34) |
| [0014](0014-alacak-piyasasi-satici-ve-alici-kurallari.md) | Alacak piyasası: satıcının güncel agent cüzdanı olması, kurumun alıcı olamaması, güncel ve sıfırda kısıtsız alıcı listesi | BC-25 (#33) |
| [0015](0015-travel-rule-commitment-ve-esik.md) | Travel Rule commitment'ı: salt'lı ve job'a bağlı tanım, yalnızca `Open` işe bağlama, eşiğe eşit tutarda zorunluluk | BC-34 (#71) |
| [0016](0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md) | Uyuşmazlık: M-of-N oy ve set değişiminde sayımın yeniden başlaması, son tarih ve lapse, işte tek dispute, ispatsız bekleme başvurusu, kararın ispat kapısından ödenmesi | BC-32 (#69), BC-33 (#70) |
| [0017](0017-travel-rule-saklama-erisim-ve-paylasim.md) | Travel Rule kaydı: IVMS101 alt kümesi, sunucuda üretilen salt, zarf şifrelemesi ve anahtar döndürme, izinli okuma, erişim kaydı, yapılandırmadaki saklama süresi | BE-23 (#73) |
| [0018](0018-x402-facilitator.md) | x402 facilitator'ı: varsayılan kendi facilitator'ımız (resmi `@x402/svm` şeması, süreç içi), harici facilitator yapılandırmayla; CAIP-2 ağlar ve Solana USDC | BE-24 (#79) |
| [0019](0019-fee-payer-politikasi.md) | Fee payer: izinli program ve talimat listesi, sponsor anahtarının yalnızca ücret / rent yerlerinde durması, Squads vault mesajlarının denetimi, compute budget tavanı, tx başına tavan ve günlük bütçe, sponsor anahtarının saklanması | BE-27 (#82) |
| [0020](0020-sanctions-screening-kaynaklari-ve-saglayici.md) | Sanctions screening: OFAC SDN listesi ve Chainalysis sanctions API birlikte, herhangi biri işaretlerse `Flagged`, kaynak hatasında karar yok, `source_hash` kanıt belgesinin hash'i | BE-16 (#49) |

## §12 kararlarının karşılığı

| [§12](../analysis/square-solana-analysis.md#12-kararlar) | ADR |
|---|---|
| 12.1 Mimari ve taşıma | 0003, 0004 |
| 12.4 DID | 0006 |
| 12.4 Anchor | 0007 |
| 12.4 Upgrade authority | 0008 |
| 12.4 DB | 0009 |
| 12.4 Hosting | 0002 (ilk karar Vercel ve Railway idi) |
| 12.4 Wallet | 0010 |
| 12.4 Monorepo araçları | 0011 |
| 12.4 npm isim alanı | 0001 |
| 12.5 Lisans | 0005 |

§12.2 (teslim modeli), §12.3 (kapsam), §12.4'teki görsel kimlik satırı ve §12.6 (proje yönetimi) ürün
ve süreç kararlarıdır; ADR'ye dönüştürülmedi, kaynakları §12'dir.

## Kurallar

- Dosya adı `NNNN-<başlığın-kısa-hali>.md` biçimindedir; numara bir sonraki boş dört haneli sayıdır.
- Gerekçe yalnızca kaynakta yazılı olandır; kaynak gerekçe vermiyorsa ADR bunu açıkça söyler.
- Kabul edilmiş bir ADR'nin kararı yerinde değiştirilmez: yeni karar yeni bir ADR'dir ve eskisinin
  durumu "Yerine geçildi (ADR NNNN)" olur. Uygulama durumu ve açık noktalar güncellenebilir.
