# ADR 0017: Travel Rule kaydının saklanması, erişimi ve paylaşımı

- **Durum:** Kabul edildi
- **Issue:** BE-23 (#73)
- **Karar kaynağı:** BE-23 iş kalemleri 1–4 ve kabul kriterleri ("Zincirde yalnızca commitment", "PII erişimi
  loglanıyor", "Commitment doğrulama testi"); [ADR 0015](0015-travel-rule-commitment-ve-esik.md) "Açık
  noktalar"; [veri modeli](../design/data-model.md) `travel_rule_records` satırı; 2026-10-06
- **Kapsam:** `apps/api` (`src/travel-rule/`, `/v1/jobs/{job}/travel-rule*`), `db` (`travel_rule_records`,
  `travel_rule_grants`, `travel_rule_accesses`), `@squaresdk/solana-types` (Travel Rule şemaları),
  `@squaresdk/solana-sdk` (`SquareApi`), API sözleşmesi v0.15.0

## Bağlam

- **ADR 0015'in bıraktıkları:** Commitment `sha256("square/travel-rule/v1" ‖ job ‖ salt ‖ sha256(kayıt))`'tir.
  Zincirde yalnızca commitment durur. Kaydın şeması, şifrelenmesi, saklanması ve karşı tarafa iletilmesi
  BE-23'e bırakıldı.
- **Issue'nun istedikleri:**
  - Kişisel veri zincir dışında, şifreli tutulur. Anahtar yönetimi, erişim kontrolü ve denetim kaydı vardır.
  - Commitment salt'lıdır.
  - Karşı tarafla paylaşım için minimal bir arayüz vardır.
  - Bir veri saklama süresi politikası vardır.
- **Veri modeli (BE-04):** `travel_rule_records` tablosu zarf şifrelemesi için açılmış ama hiçbir servis
  yazmıyordu. Sütunları: şifreli veri, IV, sarılmış anahtar ve anahtar kimliği; düz metin sütunu yok.
- **Kaynak tasarım** (Arc Square, `docs/design/travel-rule.md`):
  - Kişisel veriyi hiç tutmamayı ve yükü yükümlü kuruluşlar arasında zincir dışında taşımayı önerir.
  - Kaydın biçimi için IVMS101'i önerir.
  - Square'de yükümlü kuruluşun kim olduğunun hukuki bir karar olduğunu kaydeder.
  - Solana tasarımımız ise saklamayı BE-23'e ve API'ye vermiştir (ADR 0015, veri modeli). Commitment'ı kurum
    kendi imzasıyla bağladığı için (`commit_travel_rule`), Arc'taki imzalı attestation gereği burada yoktur.

## Karar

1. **Kaydın şeması** (`TravelRuleRecord`, `@squaresdk/solana-types`):
   - Originator ve beneficiary (gerçek ya da tüzel kişi), iki tarafın VASP'ı, transferin `amount` ve `mint`'i.
   - Alan adları ve kimlik türü kodları IVMS101'dendir (`primaryIdentifier`, `accountNumber`, `CCPT`, `LEIX`
     …). Kayıt IVMS101'in tamamı değil, düz bir alt kümesidir.
   - Şema `strict`'tir: tanınmayan alan reddedilir. Değerler kırpılır; commitment kırpılmış kayıt üzerinden
     hesaplanır ve okumada aynı kayıt döner.
   - Kaydın `amount` ve `mint`'i job'un zincirdeki değeriyle aynı olmalıdır.
2. **Commitment ve salt:**
   - Kaydı kurumun güncel yetkilisi API'ye yazar (`PUT /v1/jobs/{job}/travel-rule`).
   - API her yazmada 32 baytlık yeni bir salt üretir ve commitment'ı SDK'nın `travelRule.commitment`'ıyla
     hesaplar.
   - Kurum dönen commitment'ı `commitTravelRule` ile bağlar.
   - Job zincirde `Open` değilse yazma reddedilir (409). Fonlanan işin commitment'ı değişmez (ADR 0015 §3);
     kaydı da değişmez.
3. **Şifreleme:**
   - Zarf şifrelemesi, `@squaresdk/solana-hardening`'in `SecretBox`'ıyla (AES-256-GCM; değer
     `sq1.<anahtar>.<iv>.<veri>`). `{ kayıt, salt }` kayda özgü rastgele 32 baytlık veri anahtarıyla
     şifrelenir.
   - Veri anahtarı ana anahtar halkasının etkin anahtarıyla sarılır (`API_TRAVEL_RULE_KEYS`,
     `API_TRAVEL_RULE_ACTIVE_KEY_ID`).
   - Ek doğrulanan veri: şifreli kayıt için `job` ve `commitment`, sarılmış anahtar için `job`. Anahtar
     kimliği `SecretBox` değerinin içindedir; değiştirilirse değer başka anahtarla açılmaya çalışılır ve
     doğrulanamaz.
   - Veritabanında düz metin yoktur.
4. **Anahtar döndürme:**
   - Yeni anahtar halkaya eklenip etkin yapılır.
   - Bakım, eski anahtarla sarılmış veri anahtarlarını yeniden sarar; kayıtlar yeniden şifrelenmez.
   - Eski anahtar, onu gösteren kayıt kalmayınca halkadan çıkarılır. Halkada olmayan anahtarla sarılmış kayıt
     açılmaz.
5. **Erişim:**
   - Kaydı kurumun güncel yetkilisi yazar. Kural `putPolicyMeta` ile aynıdır: multisig yoksa kurum anahtarı,
     varsa `Initiate` yetkili Squads üyesi.
   - Kaydı yetkili ve onun izin verdiği cüzdanlar okur (`POST …/travel-rule/grants`). İzin süreli ve geri
     alınabilirdir. Karşı VASP ve denetçi bu yolla okur.
   - Uçlar yalnızca cüzdan oturumuyla çağrılır; API anahtarı kabul edilmez.
6. **Erişim kaydı** (`travel_rule_accesses`):
   - Kişisel veriye dokunan her işlem yazılır: yazma, okuma, izin, geri alma, silme. Satırda işlemi yapan
     cüzdan, izin verilen cüzdan, istek kimliği ve zaman bulunur.
   - Kayıt işlemle aynı transaction'dadır. Okumada önce erişim kaydı yazılır, kayıt sonra açılır.
   - Kurumun yetkilisi okur (`GET …/travel-rule/access`). Erişim kaydı kişisel veri içermez ve silinmez.
7. **Doğrulama:**
   - Okumada API, commitment'ı açılan kayıttan ve salt'tan yeniden hesaplar. Saklanan commitment'la
     uyuşmazsa kaydı döndürmez.
   - Yanıt, zincirdeki `Job.travel_rule_commitment`'ı ve eşleşmeyi (`committed`) taşır.
   - Karşı taraf aynı hesabı SDK ile kendisi yapar.
8. **Saklama süresi:**
   - Kayıt son yazmadan `API_TRAVEL_RULE_RETENTION_DAYS` gün sonra silinir. Silinenler şifreli kayıt,
     sarılmış veri anahtarı ve anahtar kimliğidir.
   - Commitment, kaydın özeti ve erişim kaydı kalır. Zincirdeki commitment zaten kalıcıdır.
   - Süre hukuki karardır: varsayılan değeri yoktur, kurulumda verilir.

## Gerekçe

Bu bölümdeki gerekçeler bu ADR'ındır; kaynaklarda gerekçe yoktur.

- **Salt'ı sunucunun üretmesi:** Salt kayıtla birlikte saklanır ve karşı tarafa onunla verilir. Sunucuda
  üretmek, istemcinin zayıf ya da tekrar eden salt kullanmasını engeller. Her yazmada yeni salt, aynı kaydın
  iki commitment'ının ilişkilendirilmesini de önler.
- **Zarf şifrelemesi:** Ana anahtar yalnızca veri anahtarlarını sarar. Döndürmede kayıtları yeniden şifrelemeden
  yalnızca sarılmış anahtarlar yenilenir. Silmede sarılmış anahtarın silinmesi, şifreli veriyi kalıcı olarak
  açılmaz yapar.
- **Ek doğrulanan veri:** Şifreli veri satırlar arasında taşınırsa açılmaz. Erişim kontrolü, şifreli verinin
  bir başka job'un satırına kopyalanmasıyla atlatılamaz.
- **Yalnızca oturum:** Okuma kişisel veridir. Erişim kaydındaki her satır, cüzdanın imzaladığı oturuma, yani
  bir kişiye bağlanır. Paylaşılan bir servis anahtarında bu bağ kurulamaz.
- **Önce erişim kaydı:** Kaydı yazılamayan okuma, kaydı açmaz. Bu sırayla iz bırakmayan bir okuma olmaz.
- **Saklama süresi yapılandırmada:** Süre yargı bölgesine göre değişir ve hukuki karardır. Eşik için ADR
  0015'teki kural burada da geçerlidir.

## Sonuçlar

- **Uygulama:**
  - `apps/api/src/travel-rule/{crypto,service,maintenance}.ts`, `apps/api/src/routes/travel-rule.ts`.
  - Şifreleme ve anahtar halkası `@squaresdk/solana-hardening`'in `SecretBox`'ı ve `parseSecretBoxKeys`'idir.
    `crypto.ts` yalnızca zarfı kurar: veri anahtarı, ek doğrulanan veri, yeniden sarma.
  - Kurum yetkilisi kuralı `apps/api/src/institution-authority.ts`'te ortak; `putPolicyMeta` de onu kullanır.
- **Veritabanı:**
  - `travel_rule_records` genişledi: özet, yazan, saklama sonu, silinme. `kms_key_id` yerine ana anahtar
    halkasının `key_id`'si geldi.
  - Şifreli kayıt ve sarılmış anahtar `SecretBox` değeri (metin) olarak durur. IV ve algoritma değerin
    içindedir; ayrı sütunları yoktur (`20261006113710_travel_rule_secret_box`).
  - Yeni tablolar: `travel_rule_grants`, `travel_rule_accesses`. CHECK kısıtı: silinmiş kaydın şifreli
    alanlarının hepsi boş, silinmemişin hepsi dolu.
- **Sözleşme v0.15.0:** Beş operasyon: `putTravelRule`, `getTravelRule`, `createTravelRuleGrant`,
  `deleteTravelRuleGrant`, `listTravelRuleAccess`. Travel Rule şemaları eklendi.
- **Testler:** `apps/api/test/travel-rule.test.ts` ve `apps/api/test/units.test.ts`. Kapsadıkları:
  - veritabanında ve `commitTravelRule` tx'inde kişisel veri olmaması;
  - karşı tarafın commitment'ı kayıttan yeniden hesaplaması;
  - izin, geri alma ve süresi dolan izin;
  - erişim kaydı;
  - fonlanmış işte değişmeme;
  - multisig yetkilisi;
  - saklama süresiyle silme;
  - anahtar döndürme;
  - şifreli verinin başka satırda ve değiştirilince açılmaması.

## Açık noktalar

- **Saklama süresinin değeri:** Hukuki karardır; kurulumda verilir (BE-05).
- **Ana anahtarların yeri:** Anahtarlar Railway'in secret'larındadır. Bir KMS kullanılırsa, halka arayüzünün
  (`Keyring`) sarma ve açma işlemi KMS'e taşınır; kayıt biçimi değişmez.
- **Kurumlar arası taşıma protokolü:** Yükü yükümlü kuruluşlar arasında taşıyan protokol (ör. TRP, TRISA) bu
  ADR'ın kapsamında değildir. Burada paylaşım, izinli cüzdanın API'den okumasıdır.
- **Yükümlü kuruluş:** Square'de yükümlü kuruluşun kim olduğu hukuki bir karardır (kaynak tasarım §8).
