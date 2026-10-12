# Töreni yürütmek

Koordinatörün ve katılımcının yazdıkları. Plan ve açık kararlar: [README.md](README.md).

Her adım `circuits/payment-compliance/scripts/ceremony.mjs` üzerinden gider ve transcript'i iş yapılırken yazar. Sonradan kurulan bir kayıt, yayımlanan kayıt olamaz. Komutlar `circuits/payment-compliance/` içinde çalışır.

```bash
npm ci
npm run fetch-ptau          # PPoT katkı 80, hash'iyle doğrulanır
CIRCOM=/path/to/circom npm run build   # circom 2.2.3; build/payment.r1cs
```

## Açılış (koordinatör)

Duyuru beacon turuyla birlikte **önceden** yayımlanmış olmalıdır ([beacon.md](beacon.md)).

```bash
node scripts/ceremony.mjs init --beacon-round <R> --announcement <duyurunun adresi>
```

`init` şunları yapar:

- **Başlangıç anahtarı:** Devreyi derler, PPoT'u doğrular ve `build/ceremony/payment_0000.zkey`'i kurar. Bu anahtar devreden ve PPoT'tan belirlenimci olarak türer; içinde rastgelelik yoktur.
- **Transcript:** Devrenin r1cs ve devre hash'ini, phase-1'i, beacon turunu, turun düşeceği anı ve duyurunun adresini yazar.
- **Reddettikleri:**
  - Geçmişte kalmış bir tur. Duyuru katkılardan önce gelmelidir.
  - Var olan bir transcript. O transcript ilk törenin tek kaydıdır.

`build/ceremony/transcript.json` ve `payment_0000.zkey` yayımlanır; ikisinde de gizli bir şey yoktur. İlk katılımcıya bunlar ve r1cs dosyası (`build/payment.r1cs`; katılımcı derlemek istemezse) verilir.

## Her katkı (katılımcı)

Katılımcı güvendiği bir makinede şunları hazırlar:

- **Kurulum:** Yukarıdaki kurulum; devre derlenmiyorsa koordinatörün yayımladığı r1cs `build/payment.r1cs`'e konur.
- **Dosyalar:** Aldığı transcript `build/ceremony/transcript.json`'a, son anahtar ise transcript'in adını verdiği yere konur (ör. `build/ceremony/payment_0002.zkey`).

```bash
node scripts/ceremony.mjs contribute "Adınız ya da kurumunuz"
```

`contribute` sırasıyla:

1. **Kapanış denetimi:** Beacon turunun henüz düşmediğine bakar; düştüyse katkılar kapanmıştır.
2. **Anahtar denetimi:** Anahtarın SHA-256'sını transcript'teki son kayıtla karşılaştırır. Halkalar arasında değiştirilmiş bir anahtar burada durur. Transcript'in kaydetmediği bir anahtar varsa da durur; bu, kaydedilmeden yarıda kalmış bir katkıdır ve elle uzlaştırılır.
3. **Zincir denetimi:** r1cs'in törenin devresi olduğunu denetler. Ardından anahtarı devreye ve PPoT'a karşı doğrular (`snarkjs zkey verify`, bütün katkı geçmişi dahil) ve içindeki katkıları transcript'le karşılaştırır.
4. **Katkı:** snarkjs'e bırakır. snarkjs **rastgele bir metin** ister: yalnızca sizin göreceğiniz bir şey yazın. snarkjs bunu işletim sisteminden aldığı 64 baytla karıştırır; uzun olması gerekmez, bir yere yazılmamalı ve paylaşılmamalıdır. Araç bu değeri ne üretir ne argüman olarak verir ne görür: argümanlar `ps` ile herkese görünür.
5. **Kayıt:** Yeni anahtar yazılır yazılmaz transcript'e geçirir, ardından anahtarı geri okuyup katkının hash'ini ve adını doğrular.

Çıktıdaki **katkı hash'i** ve **zkey SHA-256'sı** hemen yayımlanır. Sonraki katılımcı aldığı anahtarı bu hash'le denetler; halkalar arasında anahtar değiştirilmesini bu durdurur ve yalnızca hash'ler tören sürerken herkese açıksa işe yarar.

Sonra entropi yok edilir. Yazılıp hiçbir yere kaydedilmediyse terminali kapatmak yeter. Zincirin bütün güvenliği tek bir katılımcının tam olarak bunu yapmasına dayanır.

Katılımcı yeni anahtarı ve güncellenmiş transcript'i koordinatöre geri gönderir. Koordinatör bunları kendi `build/ceremony/`'sine koyar, `verify`'ı koşturur ve sonraki katılımcıya geçer:

```bash
node scripts/ceremony.mjs verify
```

## Kapanış

Katkı penceresi kapandıktan ve duyurulan tur düştükten sonra:

```bash
node scripts/ceremony.mjs beacon
node scripts/ceremony.mjs finalize
```

`beacon` sırasıyla:

1. **Ön koşullar:** En az bir katkı ister; bu projenin tek başına kurduğu bir anahtarın üstüne beacon bir tören değildir.
2. **Zincir:** drand'dan zincir bilgisini alır ve quicknet olduğunu hash'ini yeniden hesaplayarak doğrular; grup anahtarının sabit anahtarla aynı olduğuna bakar.
3. **Tur:** Duyurulan turu alır. İmzasını **sabit** quicknet anahtarına karşı doğrular ve turun son katkıdan sonra düştüğüne bakar.
4. **Uygulama:** Zinciri son kez devreye ve transcript'e karşı doğrular, imzayı beacon değeri olarak uygular (`snarkjs zkey beacon`, yineleme üssü 10), turun kaydını `drand-quicknet-round-<R>.json` olarak yazar.

`finalize` sırasıyla:

1. **Yayın:** Son anahtarı `artifacts/payment.zkey`'e, transcript'i ve tur kaydını `artifacts/ceremony/`'e koyar.
2. **Release hattı:** `scripts/release-artifacts.mjs write --vector`'ı koşturur. Hat zkey'in katkılarını transcript'le karşılaştırır ve manifest'e `phase2.kind: "ceremony"` ile transcript'in SHA-256'sını yazar. Doğrulama anahtarını, `programs/square-verifier/src/release_vk.rs`'i ve gerçek bir ispat vektörünü de yeniler.

Sonra:

```bash
npm run program-proofs                       # program testlerinin ispatları, yeni anahtarla
npm run artifacts:check                      # Node 24 (.nvmrc); ya da scripts/clean-room.sh check
node scripts/ceremony.mjs verify-chain       # üçüncü tarafın yaptığının aynısı
cd ../.. && cargo test -p square-verifier    # ispat vektörü yeni anahtarla
```

Ardından [README.md](README.md#tören-bittikten-sonra)'deki 3–6. adımlar: VK sürümü, devnet upgrade'i, disclosure ve kabul.

## Olağan dışı durumlar

| Durum | Ne yapılır |
|---|---|
| `contribute` yarıda kesildi, anahtar yazıldı ama transcript bilmiyor | Araç sonraki adımı "ahead of the transcript" diyerek durdurur. Katılımcı hash'i yayımladıysa transcript o anahtardan elle tamamlanır (`snarkjs zkey verify` çıktısındaki hash ve ad). Yayımlamadıysa anahtar silinir ve katkı yeniden yapılır |
| Bir katılımcı yanıt vermiyor | Sıradaki katılımcıya son doğrulanmış anahtar verilir; zincir bekleyen katılımcıyı atlar |
| Katkılar duyurulan tur düşmeden bitmedi | `contribute` tur düştükten sonra reddeder. Koordinatör ya yapılmış katkılarla kapatır (`beacon`) ya da daha sonraki bir turu yeniden duyurup yeni bir tören açar (`init`); iki transcript birlikte saklanır |
| Bir anahtar transcript'in kaydıyla aynı değil | Araç durur. Doğru anahtar, son yayımlanmış hash'le bulunur |
