# ADR 0017: Sanctions screening kaynakları ve sağlayıcı seçimi

- **Durum:** Kabul edildi
- **Issue:** BE-16 (#49)
- **Karar kaynağı:** BE-16 iş kalemi 1 ("Kaynak: OFAC SDN listesi + sağlayıcı API adaptörü (sağlayıcı seçimi
  ADR)") ve kabul kriterleri; analiz §4.2 ve §6 satır 22; 2026-10-06
- **Kapsam:** `apps/screener` (kaynaklar, karar, `source_hash`), square_registry `record_screening` (BC-27),
  `screening_decisions` tablosu

## Bağlam

- **Zincir tarafı (BC-27):** Kayıt `ScreeningRecord { wallet, status: Clear | Flagged, source_hash,
  screened_at, expires_at }`'tir ve yalnızca `RegistryConfig.screener_authority` yazar. Escrow fonlamada,
  alacak alımında ve release'te kaydın `Clear` ve taze olmasını ister
  ([program arayüzü](../design/program-interface.md) §10.1, [ADR 0013](0013-release-keeper-ucreti-iade-ve-itibar.md),
  [ADR 0014](0014-alacak-piyasasi-satici-ve-alici-kurallari.md)). IDL `source_hash`'i "screening kanıtının
  hash'i (sağlayıcı yanıtı / liste sürümü)" diye tanımlar.
- **Kaynak projeler:**
  - Covenant statik bir `sanctions-list.json` kullanıyordu: zincir dışı ve elle güncellenen liste
    (analiz §6 satır 22).
  - Arc (Square'in referansı) sanctions screening'i TRM API ile yapıyordu (analiz §4.2).
- **Issue'nun istediği:**
  - kaynak OFAC SDN listesi ve bir sağlayıcı API adaptörü;
  - sağlayıcı seçimi bu ADR'de;
  - listedeki adres için `ScreeningRecord` tx'i;
  - TTL yenileme;
  - authority anahtarının secret store'da durması.

## Değerlendirilen seçenekler

1. **Yalnızca OFAC SDN listesi.**
   - Artıları: ücretsiz ve kamusal; kanıtı (listenin SHA-256'sı) herkes yeniden üretebilir; bir üçüncü
     tarafa bağımlılık yoktur.
   - Eksileri: yalnızca OFAC'ın listeye eklediği adresleri kapsar. Liste günlerce gecikebilir; listelenmiş
     bir varlığın sonradan kullandığı adresler listede yoktur.
2. **TRM Labs sanctions screening API** (Arc'ın kullandığı).
   - Artıları: toplu tarama (bir istekte birden çok adres).
   - Eksileri: ücretsiz uç adres başına yalnızca "yaptırımlı mı" bilgisini döner. Hangi listeden ve hangi
     kayıttan geldiği yanıtta yoktur; kanıt yalnızca bir boolean olur.
3. **Chainalysis sanctions screening API.**
   - Uç: `GET /api/v1/address/<adres>`, `X-API-Key`; ücretsizdir, anahtar kayıtla alınır.
   - Yanıt: eşleşme varsa `identifications[]` (kategori, ad, açıklama, kaynak adresi); yoksa boş dizi.
   - Artıları: kanıt hangi yaptırım kaydının eşleştiğini taşır; tek adres için tek GET.
   - Eksileri: tek adres başına bir istek (screener zaten cüzdan başına tarar).
4. **Ücretli kapsamlı risk sağlayıcıları** (ör. Elliptic, Chainalysis KYT): Risk puanı ve maruziyet analizi
   verir. Issue'nun istediği yaptırım listesi denetiminin ötesindedir. Ücretli olduğu için bu aşamada
   seçilmedi.

## Karar

1. **İki kaynak birlikte** taranır:
   - OFAC SDN listesi (`SDN.XML`'deki `Digital Currency Address - SOL` kimlikleri);
   - **Chainalysis sanctions screening API**.

   Sağlayıcı adaptör arayüzünün (`ScreeningSource`) arkasındadır; başka bir sağlayıcı aynı arayüzle eklenir.
2. **Birleşim:** Kaynaklardan herhangi biri işaretlerse karar `Flagged`'dır; hepsi temizse `Clear`.
3. **Fail-closed:**
   - Bir kaynak yanıt vermezse karar verilmez ve tx gönderilmez. OFAC listesi
     `SCREENER_OFAC_MAX_AGE_SECONDS`'ten eskiyse de aynıdır.
   - Zincirdeki önceki kayıt süresi dolunca escrow'u durdurur.
   - Kaynak hatası `Clear` ya da `Flagged` yazdırmaz.
4. **`source_hash`:**
   - Kanıt belgesi `{ version: 1, wallet, sources[] }`'tir. `sources[]` kaynak adına göre sıralıdır;
     her biri kaynağın kanıtını taşır:
     - OFAC: listenin SHA-256'sı, yayım tarihi, eşleşen SDN uid'leri ve adları;
     - Chainalysis: yanıt gövdesinin SHA-256'sı, eşleşmelerin kategori ve adı.
   - `source_hash`, belgenin RFC 8785 kanonik JSON'unun SHA-256'sıdır.
   - Belge denetim kaydında (`screening_decisions.evidence`) saklanır.
5. **Sağlayıcı yapılandırması:**
   - Sağlayıcı isteğe bağlıdır: `SCREENER_CHAINALYSIS_API_KEY` verilmezse yalnızca OFAC listesi taranır
     ve servis bunu açılışta uyarı olarak loglar.
   - Üretim kurulumunda anahtar verilir.

## Gerekçe

- **OFAC SDN** yasal yükümlülüğün doğrudan kaynağıdır ve kanıtı herkesçe doğrulanabilir. Covenant'ın
  statik listesinin aksine periyodik indirilir; bayatlığı ölçülür ve alarmı vardır.
- **İkinci kaynak** listenin gecikmesini ve kapsamını kapatır. Chainalysis'in yanıtı hangi kaydın
  eşleştiğini söylediği için `source_hash`'in kanıtı anlamlıdır: denetçi, `Flagged` kararının hangi
  yaptırım kaydından geldiğini görür. TRM'in ücretsiz yanıtı bunu taşımaz.
- **"Herhangi biri işaretlerse Flagged"** ve **fail-closed:** Yanlış bir `Clear` yaptırımlı bir adrese ödeme
  yapılmasına yol açar; yanlış ya da eksik karar yalnızca işlemi bekletir. İkincisi geri alınabilir,
  birincisi alınamaz.
- **Kanıt belgesinin hash'i:** Liste sürümünü ve sağlayıcı yanıtını tek bir 32 baytta birleştirir ve zaman
  içermediği için yeniden üretilebilir. IDL'deki `source_hash` tanımına uyar.

## Sonuçlar

- **Uygulama:** `apps/screener` (`src/sources/ofac.ts`, `src/sources/chainalysis.ts`, `src/evidence.ts`),
  `screening_decisions` tablosu (migration `20261006100000_screener`), 2026-10-06.
- **Bağımlılık:** Chainalysis'in ücretsiz API'si kayıt ve kullanım koşullarına bağlıdır. Koşullar değişirse
  adaptör değiştirilir; karar kuralı ve kanıt biçimi değişmez (`EVIDENCE_VERSION` yalnızca kanıt alanları
  değişirse artar).
- **Liste boyutu:** OFAC listesi onlarca MB olabilir. İndirme boyutu `SCREENER_OFAC_MAX_BYTES` ile
  sınırlıdır; yarıda kesilmiş belge reddedilir (`</sdnList>` ile bitmeli).
- **Gerçek uçlar:** OFAC'ın canlı ucuna ve Chainalysis'e karşı smoke testi dağıtımda yapılır.
  Testler sentetik SDN fikstürü ve sahte fetch kullanır.

## Açık noktalar

- Sağlayıcının ücretli bir risk ürünüyle (maruziyet / risk puanı) değiştirilmesi ya da genişletilmesi
  kapsam kararıdır; bu ADR yalnızca yaptırım listesi denetimini kapsar.
- Gerçek fonlama reddinin uçtan uca denemesi BE-36'dadır (localnet).
