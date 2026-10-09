# square_verifier

Akışın 7. adımı: kurum, release'ten önce Groth16 ispatını job'a bağlar; program ispatı doğrular ve
escrow'un release'te okuyacağı `ReleaseProof` hesabını yazar. Policy'li işte kurum, agent kabul etmeden önce
aynı devreyle bir ön-ispat da bağlar (`PreflightProof`,
[ADR 0028](../../docs/decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)). Arayüz
[program arayüzü §10.3](../../docs/design/program-interface.md#103-square_verifier)'tedir; IDL'i sözleşme
IDL'iyle (`idl/square_verifier_contract.json`) aynıdır. Stripe MPP fiat rayı (BC-37):
[ADR 0024](../../docs/decisions/0024-stripe-mpp-fiat-rayi.md).

| Talimat | Ne yapar |
|---|---|
| `init_verifier_config` | Tekil `VerifierConfig`'i açar; yalnızca programın yükseltme yetkilisi (`program` + `program_data`). Okunan escrow ve policy programlarının kimlikleri, MPP yetkilisi, doğrulama anahtarının sürümü |
| `set_preflight_proof` | Kabul öncesi ön-ispat (ADR 0028): `Open` ya da `Funded` policy'li işte (fiat dahil) ispatı işin kendi koşullarıyla kurulan 13 sinyale karşı doğrular: net `job.amount`, payee `job.agent_wallet`, günlük sayaç 0, makbuz 0. Ret kodunda kalıcı bit (işlem başı tavan, mint, engelli payee) ya da günlük tavan biti varsa `PreflightRefused`; zaman penceresi ve kategori geçicidir. `PreflightProof`'u bağlamadaki agent cüzdanıyla (`payee`) yazar; escrow `accept_job`'da onu, cüzdan değişmediyse ister. Kabule kadar yeniden bağlanabilir. Event `PreflightProofSet` |
| `set_compliance_proof` | İspatı release devresinin 13 sinyaline karşı doğrular ve `ReleaseProof`'u yazar (ret kodu 0 ise `Compliant`, değilse `Refused` + kod). Tüketilene kadar yeniden bağlanabilir |
| `record_release` | Yalnızca escrow'un `["escrow_authority"]` PDA'sıyla (CPI): ispatı tüketir, `Compliant` ise günlük sayacı net tutar kadar ilerletir |
| `verify_mpp_payment_proof` | Fiat işin Stripe ödemesini bağlar. Hemen önceki talimat, `config.mpp_authority`'nin `"square/mpp-attestation/v1" ‖ job ‖ stripe_receipt_hash ‖ amount` üzerindeki imzasını doğrulayan Ed25519 precompile talimatıdır (tek imza, kendi verisinde). İspat aynı 13 sinyale karşı: `refusal_code` 0, net işin tutarı, payee agent, sinyal 12 makbuz commitment'ı. `Compliant` `ReleaseProof`, `MppPaymentVerified` |
| `update_mpp_authority` | Config admin'i (Squads vault'u) MPP attestation anahtarını program upgrade'i olmadan değiştirir; sıfır anahtar fiat rayını kapatır; `verify_mpp_payment_proof` sıfır anahtarı Ed25519 talimatını okumadan reddeder (BC-39 P-20) |

- **Sinyaller** ([`src/signals.rs`](src/signals.rs), [release-circuit.md](../../docs/design/release-circuit.md)
  §2, §6 yol A): 10'unu program hesaplardan kurar. Bunlar:
  - job'un policy anlık görüntüsü (commitment, günlük tavan);
  - payee (alacak satıldıysa alıcı, değilse `Job.agent_wallet`) ve mint;
  - kurumun ispat anının UTC gününe göre sayacı;
  - job adresi ve `stripe_receipt_hash = 0`.

  `refusal_code`, `net_amount` ve `proof_timestamp` kurumun beyanıdır. Başka bir payee, tutar, mint,
  politika ya da job için yapılmış ispat `InvalidProof` ile düşer.
- **Bağlama koşulları:**
  - imzacı kurumun güncel yetkilisi (multisig bağlıysa vault'u);
  - politika kuruma ve job'a ait;
  - `set_preflight_proof`'ta job (iki rayda da) `Open` ya da `Funded`;
  - `set_compliance_proof`'ta escrow rayındaki job `Delivered`, `Disputed` ya da `Resolved`;
    `verify_mpp_payment_proof`'ta fiat job `Delivered` (yanlış ray `RailMismatch`);
  - ispatın anı zincirin saatine 600 s içinde.

  Hesaplar CPI'sız okunur ([`src/linked.rs`](src/linked.rs)): owner `VerifierConfig`'teki program
  kimliği, PDA kaydın kendi alanlarıyla yeniden türetilir.
- **Tazelik ve sayaç:** [ADR 0012](../../docs/decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md).
  - Sayaç yalnızca release'te ilerler.
  - Release'te ispat ancak payee, net tutar, mint, gün ve sayaç aynıysa tazedir
    (`square_common::release::check_fresh`, escrow BC-24).
  - `record_release` gün ve sayaç kuralını ilerletmeden önce yeniden uygular.
- **CU:** `set_compliance_proof` ~195 bin (13 public input'lu Groth16 doğrulaması; işlem compute unit
  sınırını yükseltmelidir), `verify_mpp_payment_proof` ~179 bin, `set_preflight_proof` ~168 bin,
  `record_release` ~11 bin.

## Doğrulama anahtarı

`SQUARE_RELEASE_VK` (13 sinyal), [`src/release_vk.rs`](src/release_vk.rs).
`circuits/payment-compliance/scripts/release-artifacts.mjs` üretir ve commit'lenmiş zkey'e karşı denetler.
`RELEASE_VK_VERSION = 1`: BC-20'nin geliştirme phase-2'si. Bu anahtar herhangi bir güvence taşımaz
(devre README'si, Disclosure); kamusal tören BC-38'de.

## Testler

```bash
anchor build
cargo test -p square-verifier
cargo test --manifest-path tests/programs/Cargo.toml --test verifier --test mpp --test preflight
```

- `cargo test -p square-verifier` iki şeyi doğrular:
  - anahtarın pipeline'ın gerçek ispatını doğruladığını ve tek sinyal değişikliğini reddettiğini;
  - [`src/signals.rs`](src/signals.rs)'in o ispatın 13 sinyalini birebir kurduğunu.
- [`tests/programs/tests/verifier.rs`](../../tests/programs/tests/verifier.rs) programı escrow, registry
  ve policy ile LiteSVM'de çalıştırır:
  - İspatlar gerçek ispatlardır ([`tests/fixtures/release-proofs.json`](../../tests/programs/tests/fixtures/release-proofs.json));
    üreticisi `circuits/payment-compliance/scripts/program-proofs.mjs`.
  - Kurum, agent ve mint devrenin test dünyasıyla aynı etiketlerden türetilir.

## Köken ve lisans

Aperture `programs/verifier`'dan geçmişiyle taşındı (BC-05, [provenance](../../docs/provenance/BC-05.md)).
BC-11, RISC Zero v1'i ve transfer-hook yollarını kaldırdı. BC-21 programı Square arayüzüne göre yeniden
yazdı: Aperture'ın 10 sinyalli anahtarı (`APERTURE_PAYMENT_VK`), eski MPP talimatı, `initialize_operator_state`,
`ProofRecord` ve `ComplianceStatus` kaldırıldı. BC-37 MPP yolunu release devresiyle yeniden yazdı: anahtar
derleme zamanı sabiti yerine config'tedir, attestation işe ve tutara bağlıdır. Lisans: MIT,
[`LICENSE`](LICENSE) (Aperture'ın telif bildirimi).
