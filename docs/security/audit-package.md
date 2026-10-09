# Dış audit paketi: programlar

**Issue:** BC-39 (#93) · **Kullanan:** BC-40 (#96, firma ve kapsam), BC-41 (#97, yürütme) · **Ağ:** yalnızca devnet
([ADR 0027](../decisions/0027-yalnizca-devnet.md))

Bu belge dış audit firmasına verilecek kapsamı, belgeleri, derleme ve test yolunu, dağıtımı ve bilinen bulguları tek
yerde toplar. İç inceleme [review-bc-39.md](review-bc-39.md)'dedir.

## 1. Kapsam

| Bileşen | Yol | Kaynak (satır) | Talimat |
|---|---|---|---|
| `square_escrow` | [`programs/square-escrow`](../../programs/square-escrow/) | 3 755 | 22 |
| `square_verifier` | [`programs/square-verifier`](../../programs/square-verifier/) | 1 353 | 5 |
| `square_registry` | [`programs/square-registry`](../../programs/square-registry/) | 622 | 8 |
| `square_policy` | [`programs/square-policy`](../../programs/square-policy/) | 428 | 6 |
| `square-common` (programların ortak crate'i) | [`crates/square-common`](../../crates/square-common/) | 1 237 | — |

- **Commit:** audit'in yapılacağı commit BC-40'ta sabitlenir. Bu paket main `2bd0c80`'e göre yazıldı. Açık PR'lar
  programları değiştirir: BC-38'in `sync_vk_version`'ı (#196). Audit commit'i bunlardan sonra seçilmelidir.
- **Sözleşme:** [program arayüzü](../design/program-interface.md) v0.7.0. Sözleşme IDL'leri [`idl/`](../../idl/)'dadır;
  derlenen IDL'in sözleşmeyle aynı olduğunu CI denetler (`scripts/ci/idl-conformance.mjs`).
- **Kapsam dışı:**
  - off-chain servisler, API ve web (BE-32, [review-be-32.md](review-be-32.md));
  - release devresinin kendisi ve trusted setup (BC-38, [release-circuit.md](../design/release-circuit.md));
  - Squads v4, SPL Token, Associated Token Account ve Ed25519 precompile programları;
  - Token-2022 uzantıları (settlement mint'i klasik SPL Token'dır, P-17).

## 2. Belgeler

Okuma sırası önerisi:

1. [Program arayüzü](../design/program-interface.md):
   - roller (§2);
   - programlar arası erişim kuralları (§4);
   - PDA seed tablosu (§5);
   - escrow'un durum makinesi (§6);
   - talimat, hesap ve hata tabloları (§10).
2. [Threat model](program-threat-model.md) ve [hesap kısıtı matrisi](program-constraints.md).
3. Kararlar:

   | Konu | ADR |
   |---|---|
   | Upgrade authority (2-of-3 Squads) | [0008](../decisions/0008-upgrade-authority-2-of-3-squads.md) |
   | İspat tazeliği ve günlük sayaç | [0012](../decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md) |
   | Release, keeper ücreti, iade ve itibar | [0013](../decisions/0013-release-keeper-ucreti-iade-ve-itibar.md) |
   | Alacak piyasası | [0014](../decisions/0014-alacak-piyasasi-satici-ve-alici-kurallari.md) |
   | Travel Rule commitment'ı | [0015](../decisions/0015-travel-rule-commitment-ve-esik.md) |
   | Dispute: M-of-N, zaman aşımı, ispatsız bekleme | [0016](../decisions/0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md) |
   | Stripe MPP fiat rayı | [0024](../decisions/0024-stripe-mpp-fiat-rayi.md), [0026](../decisions/0026-stripe-mpp-fiat-odemesi.md) |
   | Yalnızca devnet | [0027](../decisions/0027-yalnizca-devnet.md) |

4. [Release devresi](../design/release-circuit.md): public sinyaller, ret bitleri, kalıcı/geçici ayrımı.
5. [İşlem bütçesi](../design/tx-budget.md): compute unit ve address lookup table.

## 3. Derleme ve test

**Araçlar** (`Anchor.toml [toolchain]`, `rust-toolchain.toml`; `scripts/ci/toolchain.mjs` denetler):
- Anchor 1.2.0;
- Agave 4.1.2;
- rustc 1.94.1.

**Program testleri** LiteSVM'de koşar (validator gerekmez):
- Deterministik testler (`tests/programs/tests/*.rs`): gerçek Groth16 ispatlarıyla ispat kapısı, dispute, alacak
  piyasası, hesap ikamesi (BC-29), işlem bütçesi.
- Hesap kısıtlarının negatif testleri: [`constraints.rs`](../../tests/programs/tests/constraints.rs).
- Durum makinesinin tohumlu fuzz'ı ve invariant'ları: [`invariants.rs`](../../tests/programs/tests/invariants.rs)
  ([review-bc-39.md §4](review-bc-39.md#4-fuzz-ve-invariant-testi)).

Ayrıntılar: [tests/programs/README.md](../../tests/programs/README.md).

```bash
anchor build
anchor test --validator legacy --skip-build
cargo test --workspace --locked
node scripts/ci/program-coverage.mjs
SQUARE_FUZZ_SEEDS=64 SQUARE_FUZZ_STEPS=400 cargo test --locked --manifest-path tests/programs/Cargo.toml --test invariants -- --nocapture
```

**Verifiable build:**
- **Araç:** `solana-verify build`.
- **İmaj:** `solanafoundation/solana-verifiable-build:4.1.2` (digest [`verifiable-build.yml`](../../.github/workflows/verifiable-build.yml)'da ve
  [devnet kaydında](../deploy/devnet.md#deploy-bc-30-2026-10-06)); program başına `--library-name`.
- **Doğrulama:** Zincirdeki executable hash'i `solana-verify get-program-hash` ile alınır ve derlemenin hash'iyle
  karşılaştırılır.
- **Durum:** [review-bc-39.md §5](review-bc-39.md#5-verifiable-build).

## 4. Dağıtım (devnet)

| Program | Kimlik | Executable hash (zincir) | Kaynak commit'i |
|---|---|---|---|
| `square_registry` | `AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9` | `8b5781c0…6d73b2580` | `4509884` (BC-30) |
| `square_policy` | `63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4` | `22d6dbd5…d68b8c12b` | `4509884` (BC-30) |
| `square_verifier` | `8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh` | `d7ec6985…a47faab52` | `0dcb71e` (BC-37, v0.7.0) |
| `square_escrow` | `6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX` | `10ede523…5c8825e16` | `0dcb71e` (BC-37, v0.7.0) |

- **Yetki:** Upgrade authority ve üç config'in admin'i 2-of-3 Squads vault'u:
  `J73BpSowEwQWqXYHzKBnLn3kfn1EJQF71qEF38dkmwqQ` (üyeler [devnet kaydında](../deploy/devnet.md)).
- **Config değerleri:** [`scripts/deploy/networks/devnet.json`](../../scripts/deploy/networks/devnet.json).
- **Upgrade yolu:** [runbook](../runbooks/upgrade.md).

## 5. Bilinen bulgular

İç incelemenin bulguları ve durumları [review-bc-39.md](review-bc-39.md)'dedir:
- **Kritik:** 0.
- **Yüksek, 1 (P-01):** kalıcı retlerin parametrelerini kurum işten önce seçer. Düzeltildi: kabul öncesi ön-ispat
  ([ADR 0028](../decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md), program sözleşmesi v0.8.0).
- **Orta, 3:**
  - P-02: multisig'e geçişte açık işlerin yetkisi;
  - P-03: alacak satışında satıcı taranmaz;
  - P-04: screening kaydında yazım sırası yok.
- **Düşük, 12; bilgi, 5.**

Audit firmasından bu bulguların düzeltmelerinin de incelenmesi beklenir.

## 6. Odak önerisi

1. **Settlement ve dispute:** `finalize_payment`, `execute_resolution`, `lapse_dispute`.
   - vault ve bond vault muhasebesi;
   - payee'nin çözümü (alacak);
   - keeper ücreti;
   - pencerelerin sınır saniyeleri.
2. **Programlar arası okuma:** owner → PDA → discriminator sırası; okunan programların kimlikleri config'ten;
   `read_bound`'un adres bağı.
3. **Verifier:**
   - Groth16 public input'larının işe ve hesaplara bağlanması;
   - ispatın tüketilmesi ve tazeliği (`check_fresh`);
   - `record_release` CPI'ının imzacısı;
   - MPP yolunda Ed25519 precompile'ın Instructions sysvar'ıyla okunması.
4. **Alacak piyasası:** Merkle kanıtı, alıcı listesi, satıcı ve alıcı kuralları, listelemenin kapanması.
5. **Config'in açılışı ve yetki:** `program_data` doğrulaması, admin'in sabitliği (P-11), parametre sınırları
   (P-12).
6. **Hesap düzeni ve upgrade:** eklenen alanlar ve eski hesaplar (P-15).

## 7. İletişim

- Bulgular ve sorular: depo issue'ları.
- Yetki sahipleri: upgrade authority'nin üç üyesi ([ADR 0008](../decisions/0008-upgrade-authority-2-of-3-squads.md)).
