# İşlem bütçesi: boyut, compute unit ve Square ALT

**Issue:** BC-28 (#36) · **Profil:** [`packages/sdk/src/tx-profile.json`](../../packages/sdk/src/tx-profile.json) ·
**Ölçüm:** [`tests/programs/tests/tx_budget.rs`](../../tests/programs/tests/tx_budget.rs)

8 adımın her tx'i paket sınırına (1232 bayt) ve compute unit sınırına sığmalıdır. Bu belge her tx'in ölçümünü,
SDK'nın kullandığı compute unit sınırlarını ve Square address lookup table'ını (ALT) verir.

## 1. Yöntem

- **Programlar:** Derlenmiş programlar LiteSVM'de koşar. Release ispatı devrenin gerçek Groth16
  ispatıdır, `finalize_payment` verifier'a `record_release` CPI'ı yapar.
- **Tx'in biçimi:** Her tx SDK'nın kurduğu biçimdedir:
  - `SetComputeUnitLimit` (profilden) ve `SetComputeUnitPrice`;
  - alıcı tarafın ATA'sını açan idempotent talimat (`buyClaim`'de satıcı, `finalizePayment`'ta payee ve
    kurum);
  - Square talimatı.
- **İmzacılar:** Ücreti rol imzacısından ayrı bir fee payer öder.
- **En kötü durum:**
  - En uzun alanlar: kurum adı 64, agent kimliği 32, kart URI'si 200, teslim URI'si 128 bayt.
  - Policy'li iş; 16 kardeşli alıcı kanıtı.
  - ATA'sı henüz olmayan payee ve satıcı.
- **Boyut:** v0 tx'in tel boyutu (imzalar dahil), ALT'sız ve Square ALT'ıyla. ALT zincirde ALT
  programının talimatlarıyla kurulur, tx'ler onunla gönderilir.
- **Compute unit:**
  - Programlar PDA bump'ını zincirde arar. Bump araması anahtara bağlıdır, her ek deneme ~1 500 CU'dur.
  - Bu yüzden tablodaki CU, rastgele anahtarlarla 60 ölçümün en yükseğidir.

```bash
anchor build
cargo test --manifest-path tests/programs/Cargo.toml --test tx_budget -- --nocapture   # tabloyu yazar
```

## 2. Ölçüm

| Tx | Durum | İmza | Hesap | Boyut, ALT'sız | Boyut, Square ALT | CU | Sınır |
|---|---|---|---|---|---|---|---|
| `initInstitution` | 64 baytlık ad | 2 | 6 | 463 | 466 | 23 033 | 50 000 |
| `setPolicy` |  | 2 | 7 | 500 | 503 | 18 778 | 40 000 |
| `updatePolicy` |  | 2 | 6 | 434 | 434 | 7 160 | 20 000 |
| `initInstitution + setPolicy + setBuyerRoot` | web: tek tx | 2 | 7 | 629 | 632 | 40 846 | 110 000 |
| `registerAgent` | 32 baytlık kimlik, 200 baytlık kart URI'si | 2 | 6 | 700 | 703 | 17 160 | 40 000 |
| `recordScreening` |  | 2 | 7 | 493 | 465 | 16 554 | 40 000 |
| `createJob` | policy'li | 2 | 13 | 682 | 592 | 45 403 | 100 000 |
| `commitTravelRule` |  | 2 | 5 | 393 | 393 | 6 373 | 20 000 |
| `fundJob` |  | 2 | 12 | 592 | 533 | 41 076 | 90 000 |
| `acceptJob` |  | 2 | 6 | 426 | 426 | 7 812 | 20 000 |
| `submitWork` | 128 baytlık URI | 2 | 6 | 559 | 559 | 8 312 | 20 000 |
| `setBuyerRoot` |  | 2 | 6 | 426 | 426 | 7 135 | 20 000 |
| `listClaim` |  | 2 | 7 | 436 | 439 | 22 723 | 50 000 |
| `cancelClaim` |  | 2 | 5 | 362 | 362 | 4 405 | 10 000 |
| `buyClaim` | 16 kardeşli kanıt, satıcının ATA'sı açılır | 2 | 16 | **1288** (sığmaz) | 1198 | 54 781 | 110 000 |
| `syncAgentWallet` |  | 2 | 6 | 394 | 394 | 7 420 | 20 000 |
| `createJob` | policy'siz | 2 | 11 | 618 | 528 | 35 775 | 100 000 |
| `cancelJob` | fonlanmış iş | 2 | 9 | 494 | 466 | 15 344 | 40 000 |
| `finalizePayment` | policy'siz, payee'nin ATA'sı açılır | 2 | 21 | 911 | 790 | 86 918 | 200 000 |
| `setComplianceProof` | Groth16, 13 sinyal | 2 | 12 | 868 | 840 | 178 276 | 360 000 |
| `finalizePayment` | policy'li, `record_release` CPI, payee'nin ATA'sı açılır | 2 | 25 | 1039 | 856 | 99 606 | 200 000 |

"Hesap" ALT'sız tx'in statik anahtar sayısıdır; çağrılan programlar dahil.

## 3. Sonuçlar

- **Paket sınırı:**
  - Square ALT'ıyla her tx pakete sığar.
  - ALT'sız sığmayan tek tx, en derin listeyle `buyClaim`'dir (1288 bayt).
  - ALT'sız alımda kanıt en çok **14 kardeştir** (16 384 alıcı); 15–16 kardeşli listeden alım ALT ister.
- **Compute unit:**
  - En pahalı tx `setComplianceProof`'tur: Groth16 doğrulaması ~178 bin CU harcar. Bu, talimat başına
    varsayılan 200 bin sınıra yakındır, bu yüzden sınır profilden açıkça verilir.
  - Hiçbir tx 1,4 milyonluk üst sınıra yaklaşmaz.
- **ALT'ın kazancı:**
  - En büyük kazanç `finalizePayment` (183 bayt) ve `buyClaim`'dedir (90 bayt).
  - ALT'taki adresleri kullanmayan tx'te tablo referansı birkaç bayt ekler (ör. `initInstitution` +3).
    Bu tx'ler ALT'sız da sığar.

## 4. Square ALT

Cluster başına bir kez açılır; içeriği profilin `lookupTable` listesidir:

- dört Square program kimliği;
- `registry` / `escrow` / `verifier` config PDA'ları ve `escrow_authority` PDA'sı;
- settlement mint'i (`EscrowConfig.settlement_mint`);
- System, SPL Token ve Token-2022 programları;
- Instructions sysvar'ı (MPP yolunun Ed25519 doğrulaması, BC-37).

Üst düzeyde çağrılan programlar v0 mesajında statik kalır; ALT yalnızca hesap olarak geçen adresleri
kısaltır. Adresler yapılandırmadaki program kimliklerinden türetilir (BC-09), bu yüzden ALT kodda sabit
değildir.

## 5. Profil kuralı

- **Sınır:** Her tx türünün sınırı, 60 ölçümün en yükseğinin iki katıdır ve 10 bine yukarı yuvarlanır.
  - İki katlık pay bump araması içindir: en küçük talimatta da (ör. `initInstitution`, ~8 bin CU
    tabanı) 20'den fazla ek denemeyi karşılar.
  - Fazla istenen CU'nun maliyeti öncelik ücretinin çarpanıdır; 1 000 micro-lamport/CU'da 100 bin CU
    100 lamport eder.
- **Test:** `tx_budget.rs` her ölçümün sınırın `1 - headroom` katını (`headroom` 0,25: %75) aşmadığını
  denetler. Program değişikliği CU'yu bu payın içine taşırsa test düşer; sınır yeniden ölçülerek
  güncellenir.
- **Kapsam dışı:** Profili olmayan tx'ler kendi issue'larında eklenir: dispute talimatları (BC-32,
  BC-33), MPP yolu (BC-37). SDK'nın dispute akışları o zamana kadar sınır eklemez. `commit_travel_rule`
  BC-34'te eklendi.

## 6. SDK'da kullanım

`@squaresdk/solana-sdk` (`budget.ts`):

- **Sınır:** `flow.*` ve `buildSetComplianceProofTx` (`@squaresdk/solana-policy`), çağıran
  `computeUnitLimit` vermezse tx türünün sınırını ekler (`withComputeProfile`). Öncelik ücretini
  (`computeUnitPrice`) çağıran seçer.
- **Birleşik tx:** Birden çok talimatı tek tx'te birleştiren istemci `computeUnitLimitFor([...])` ile
  sınırları toplar. Toplam 1,4 milyonu aşarsa hata verir.
- **ALT:**
  1. `squareLookupTableAddresses({ programIds, pda, settlementMint })` ALT'ın adreslerini verir.
  2. `createLookupTableInstructions({ authority, payer, recentSlot, addresses })` ALT'ı açan ve dolduran
     talimatları ve ALT'ın adresini verir.
  3. ALT'ın adresi tx'lere `BuildOptions.addressLookupTables` ile verilir.
- **Paket sınırı:** `buildTx` pakete sığmayan tx'i kurarken reddeder ve ALT'ı önerir.

## 7. CCTP ile fonlama (BC-36)

`flow.receiveAndFundJob` Circle'ın `receive_message`'ını ve `fund_job`'u tek tx'te kurar
([cctp-funding.md](cctp-funding.md)).

- **Compute:** `receive_message` Circle'ın programıdır, LiteSVM ölçümüne (§2) girmez.
  - **Ölçüm:** Devnet'te yalnızca `receive_message` içeren 18 işlem, 178 061 – 194 880 CU (2026-10-06).
  - **Pay:** §5'in kuralıyla `CCTP_RECEIVE_COMPUTE_UNITS` = 390 000; tx'in sınırı `fundJob` + bu pay = 480 000.
  - **Gerçek koşu:** 202 865 CU.
- **Boyut:** Tx, Square ALT'ı ve kaynak zincirin CCTP ALT'ı (`cctpLookupTableAddresses`, 13 adres) ile 1 082
  bayttır. Mesaj 376 bayt, attestation iki imzayla 130 bayttır. ALT'sız sığmaz.
