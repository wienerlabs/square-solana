# Kamusal phase-2 töreni (BC-38)

**Issue:** [BC-38 (#92)](https://github.com/wienerlabs/square-solana/issues/92) · **Araç:** [`circuits/payment-compliance/scripts/ceremony.mjs`](../../circuits/payment-compliance/scripts/ceremony.mjs) · **Adımlar:** [running.md](running.md) · **Doğrulama:** [verifying.md](verifying.md) · **Beacon:** [beacon.md](beacon.md)

Release ispatının (`payment.circom`) Groth16 anahtarı bugün bir **geliştirme** anahtarıdır. Phase-2'si tek katkılıdır, kamusal bir tören değildir ve hiçbir güvence iddia etmez ([devrenin README'si → Disclosure](../../circuits/payment-compliance/README.md#disclosure)). Anahtarı kuran taraf toksik atığı saklamış olsaydı, sahte bir ispatla kurala uymayan bir release'i uyumlu gösterebilirdi. Törenin anahtarı devnet verifier'ına geliştirme anahtarının yerine konur; Square yalnızca devnet'te çalışır ([ADR 0027](../decisions/0027-yalnizca-devnet.md) madde 6).

Phase-1 yeniden yapılmaz: Perpetual Powers of Tau'nun 80. katkısı benimsenmiştir ve hash'iyle doğrulanır ([fetch-ptau.mjs](../../circuits/payment-compliance/scripts/fetch-ptau.mjs)). Tören yalnızca devreye özgü yarıyı, phase-2'yi üretir.

## Biçim

```
payment.r1cs + ppot_0080_14.ptau
        │  init (başlangıç anahtarı ve transcript; beacon turu burada kayda geçer)
        ▼
  payment_0000.zkey ── katılımcı 1 ──▶ payment_0001.zkey ── … ──▶ payment_000N.zkey
                                                                         │
                                       duyurulan drand quicknet turu ────┤ beacon
                                                                         ▼
                                                                payment_final.zkey
                                                                         │ finalize
                                                                         ▼
                        artifacts/payment.zkey, verification_key.json, release_vk.rs, manifest
```

- **Sıra:** Katkılar sırayla toplanır ve her biri bir sonraki başlamadan doğrulanır. Kopuk bir halka, bozulduğu adımda yakalanır.
- **Sağlamlık:** Zincir, katılımcılardan en az biri entropisini yok ettiyse sağlamdır. Bu yüzden katılımcı sayısından çok birbirlerinden ve bizden bağımsız olmaları önemlidir.
- **Beacon:** Önceden duyurulan bir drand turu son katkıyı kimsenin önceden bilemeyeceği bir değerle kapatır. Böylece bütün katılımcıların anlaşmış olması bile anahtarı seçtiremez ([beacon.md](beacon.md)).
- **Kayıt:** Transcript'i aracın kendisi yazar: başlangıç anahtarı, her katkının hash'i ve anahtarın SHA-256'sı, beacon, son anahtar ve doğrulama anahtarı. Tören bitince `artifacts/ceremony/`'de yayımlanır.

## Kararlar

| Konu | Karar |
|---|---|
| Phase-1 | PPoT katkı 80, 2^14 (`ppot_0080_14.ptau`, sha256 `3ca1149e…83db`) |
| Beacon | drand mainnet `quicknet`, **duyurulan** tur; değer turun BLS imzasıdır, yineleme üssü 10 ([beacon.md](beacon.md)) |
| Entropi | snarkjs katılımcıya kendisi sorar. Araç entropiyi üretmez, argüman olarak vermez, görmez; snarkjs bunu işletim sisteminden aldığı 64 baytla karıştırır |
| Transcript | `artifacts/ceremony/transcript.json` ve beacon turunun kaydı (`drand-quicknet-round-<R>.json`); manifest transcript'in SHA-256'sını tutar (`phase2.kind: "ceremony"`) |
| Ara anahtarlar | Repoya girmez. Son anahtar bütün katkı geçmişini taşır ve tek başına doğrulanır; koordinatör ara anahtarları tören süresince her katılımcıya verir |
| Katılımcı için gerekenler | Node, `npm ci`, PPoT dosyası (`npm run fetch-ptau`, ~19 MB), devrenin r1cs'i (circom 2.2.3 ile derlenir ya da koordinatörün yayımladığı dosya; transcript'teki SHA-256'yla denetlenir), transcript ve son anahtar. Cüzdan, anahtar ya da işlem gerekmez; yaklaşık on dakika |

## Açık kararlar

Bunlar ekibin vereceği kararlardır; araç ve belgeler hazırdır.

- [ ] **Katılımcılar:**
  - Hedef katılımcı sayısı ve davet listesi; kimin kimi davet edeceği.
  - En az bir kurum dışı ya da kurumsal katılımcı. Aynı ekipten on katılımcı yaklaşık bir katılımcı değerindedir.
- [ ] **Takvim:**
  - Katkı penceresinin açılış ve kapanış tarihi.
  - Beacon anı. Turu [beacon.md](beacon.md)'deki formül verir; an, son katkıdan sonra, yavaş bir katılımcı yeniden duyuru gerektirmeyecek kadar pay bırakarak seçilir.
- [ ] **Duyuru:** Tarih, tur ve yayın yeri; davetlerden **önce** herkese açık bir yerde (ör. issue #92'de bir yorum ve repoda bir commit). `init` duyurunun adresini ister ve turu transcript'e o anda yazar.
- [ ] **Yayın:** Her katkıdan sonra transcript ve son anahtar nereye konacak (ör. issue yorumu ve bir release eki).

## Duyuru metni

Köşeli parantezli dört değer doldurulunca yayımlanabilir.

> **Square is running a public phase-2 trusted setup ceremony.**
>
> Square releases escrowed agent payments only with a Groth16 proof that the payment fits the spending policy the institution committed on Solana. That proof rests on a trusted setup, which is sound only if at least one contributor destroyed their randomness afterwards. We are asking you to be that contributor.
>
> Phase 1 is the Perpetual Powers of Tau, contribution 80: adopted, not run by us, and verifiable by its hash. Phase 2 is the circuit-specific half and is what this ceremony produces.
>
> - **Contributions open:** [DATE]
> - **Contributions close:** [DATE]
> - **Beacon:** drand `quicknet` round **[ROUND]**, which lands at [DATE TIME] UTC. Announced now, before any contribution, so nobody can choose it afterwards.
> - **Transcripts:** [WHERE]
>
> Contributing takes about ten minutes and needs Node.js and a machine you trust: no wallet, no key, no transaction. The steps and the verification are in `docs/ceremony/` at github.com/wienerlabs/square-solana.
>
> Until this ceremony completes, the key in that repository is a development key, and it is described that way everywhere.

## Tören bittikten sonra

Sırasıyla ([running.md](running.md#kapanış)):

1. **Anahtar ve kayıt:** `finalize` son anahtarı, transcript'i ve beacon turunu `artifacts/`'a koyar, doğrulama anahtarını, Rust sabitini (`release_vk.rs`) ve manifest'i release hattıyla yazar.
2. **Testler:** Program testlerinin ispatları yeni anahtarla yeniden üretilir (`npm run program-proofs`); `cargo test -p square-verifier` ve program testleri.
3. **Verifier'ın VK sürümü:** `RELEASE_VK_VERSION` artırılır. Config'in `vk_version`'ını programınkine eşitleyen talimat (`sync_vk_version`, yalnızca config'in admin'i) programdadır ve tören anahtarıyla aynı upgrade'de zincire çıkar.
4. **Devnet:** `square_verifier`, Squads üzerinden yükseltilir ([runbooks/upgrade.md](../runbooks/upgrade.md) §6). Upgrade onaylandıktan sonra ikinci bir vault işlemi `sync_vk_version`'ı çağırır; config'in `vk_version`'ı yeni sürümü göstermelidir. İkisi de [deploy kaydına](../deploy/devnet.md) yazılır.
5. **Disclosure:** Devrenin README'sindeki geliştirme dili yalnızca o zaman kalkar; yerine törenin kaydı gelir.
6. **Kabul:** Dev anahtarıyla üretilmiş bir ispat devnet'teki verifier'da reddedilir.

## Kaynak

Arc'ın (`wienerlabs/square` @ `dc0157f`) tören planı ve aracı ([docs/ceremony](https://github.com/wienerlabs/square/tree/dc0157f/docs/ceremony)) referans alındı. Kod taşınmadı; beacon kararı, zincirle transcript'in her adımda karşılaştırılması ve entropinin araçtan geçmemesi oradaki incelemelerden gelir.
