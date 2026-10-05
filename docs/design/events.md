# Event şeması (normatif)

**Issue:** BC-16 (#23) · **Dayandığı sözleşme:** [program arayüzü](program-interface.md) v0.2.0

Square'in dört programının yayımladığı event'ler. Kaynak projelerin hiçbiri event yayımlamıyordu;
Covenant SDK'sı `msg!` log'larını metin eşleşmesiyle ayrıştırıyordu. Bu belge event'lerin tek kaynağını,
yayım yöntemini, sürümlemeyi ve tüketimi sabitler.

## 1. Tek kaynak

Event'lerin adları, alanları ve discriminator'ları sözleşme IDL'lerindedir (`idl/*.json`, `events` ve
`types`). Alan tabloları [program arayüzü §10](program-interface.md#10-referans-tabloları)'dadır.

| Program | Event | IDL |
|---|---|---|
| `square_registry` | 7 | [`square_registry_contract.json`](../../idl/square_registry_contract.json) |
| `square_policy` | 6 | [`square_policy_contract.json`](../../idl/square_policy_contract.json) |
| `square_verifier` | 4 | [`square_verifier_contract.json`](../../idl/square_verifier_contract.json) |
| `square_escrow` | 23 | [`square_escrow_contract.json`](../../idl/square_escrow_contract.json) |

Discriminator, Anchor'ın kuralıyla `sha256("event:<Ad>")`'ın ilk 8 baytıdır. Veri, discriminator'ın
ardından alanların Borsh kodlamasıdır.

## 2. Programlarda tanım: `square-common`

[`crates/square-common`](../../crates/square-common/) event'leri IDL'den üretir; alanlar elle tekrar
yazılmaz.

- `square_common::events::{registry, policy, verifier, escrow}`: sözleşmeden `declare_program!` ile
  üretilen kanonik tipler (Rust tarafında çözme ve karşılaştırma için).
- `square_common::square_<program>_events!()`: programın crate kökünde çağrılır. Aynı event'leri o
  crate'te `#[event]` olarak tanımlar. Event'in programın IDL'ine girmesi için `#[event]`'in programın
  kendi crate'inde olması gerekir. Alanlardaki tanımlı tipler (`AgentStatus`, `DisputeResolution`,
  `EscrowParams`, `ReleaseVerdict` …) programın kendi tipleridir; sözleşmedeki düzende olmaları programın
  sorumluluğudur.
- `square-common`'ın testleri, makronun ürettiği her event'in örnek değerlerde sözleşme tipiyle aynı
  baytları (discriminator dahil) verdiğini denetler (40 event). Bir programda çağrıldığında programın
  IDL'indeki event'ler ve tip tanımları sözleşme IDL'iyle aynıdır (BC-16'da `square_policy` ile
  denendi). Programın IDL'inin sözleşmeyle eşitliği CI'da denetlenir (BC-13, [CI kontrolleri](../ci.md#program-kontrolleri-ve-programların-durumu)).

```rust
use anchor_lang::prelude::*;

square_common::square_policy_events!();

pub fn set_policy(ctx: Context<SetPolicy>, /* … */) -> Result<()> {
    // …
    emit!(PolicyCommitted { /* sözleşmedeki alanlar */ });
    Ok(())
}
```

## 3. Yayım yöntemi: `emit!`

Event'ler `emit!` ile, `Program data: <base64>` log satırı olarak yayımlanır. `emit_cpi!` kullanılmaz.

Gerekçe:

- **Tx boyutu:** `emit_cpi!` her yayımlayan talimata `event_authority` ve program hesaplarını ekler; bu
  sözleşmede bir hesap listesi değişikliğidir. `set_compliance_proof` bugün de 1232 bayt sınırına yakındır
  ([program arayüzü §8](program-interface.md#açık-noktalar), 9. madde).
- **Hesaplama bütçesi:** `emit_cpi!` her event için bir öz-CPI çağrısı yapar.
- **Log sınırı:** İşlem başına log sınırı 10 KB'dir. Square talimatları tek talimatlık işlemlerdir ve
  talimat başına 1–3 event (her biri birkaç yüz bayt) ile token CPI log'ları bu sınırın çok altında kalır.

İstisna kuralı: Log'u bu sınıra yaklaşabilecek bir talimat eklenirse (çok sayıda CPI ya da büyük event),
o talimat `emit_cpi!`'e geçer. Bu bir sözleşme değişikliğidir (MINOR) ve bu belgeye yazılır.

## 4. Sürümleme

- Yayımlanmış bir event'in adı, alan sırası ve alan tipleri değişmez.
- Alan eklemek de dahil her değişiklik yeni bir event adıyla yapılır: `JobCreated` → `JobCreatedV2`.
  Discriminator adın hash'i olduğu için eski ve yeni event çözümde karışmaz.
- Geçiş süresince program ikisini birlikte yayımlayabilir; eskisinin kaldırılması ayrı bir sözleşme
  değişikliğidir.
- Event değişiklikleri program arayüzünün MINOR sürümünü artırır
  ([§11](program-interface.md#11-sözleşme-değişiklik-kaydı)); IDL, `square-common` ve SDK aynı PR'da
  güncellenir.

## 5. Tüketim

- **Çözme:** `Program data:` satırının ilk 8 baytı discriminator'dır. Satır, log yığınında (invoke
  derinliği) o anda çalışan program bir Square programıysa o programa aittir. SDK'nın `decodeEvents`'i
  (BE-08) bu kuralla çözer.
- **İndexer (BE-14):** Event'leri bu şemaya göre işler; tablolar [veri modelindedir](data-model.md).
  Zincir kaynak-gerçektir ([veri modeli](data-model.md), §1). Event'ler
  hangi hesabın değiştiğini bildirir, ayna tablolar hesap okumasıyla doğrulanır.
- **Kırpılmış log:** `Log truncated` satırı görülen işlemin event'lerine güvenilmez. İndexer o işlemin
  dokunduğu hesapları zincirden okuyarak uzlaştırır.

## 6. Program issue'ları için kontrol listesi

Sözleşmeye geçen her program (BC-15, BC-17, BC-18, BC-21, BC-22, BC-24 …):

1. Crate kökünde `square_common::square_<program>_events!()` çağrılır; event'ler elle tanımlanmaz.
2. Program arayüzündeki her event, sözleşmede tanımlı olduğu durumda `emit!` ile yayımlanır.
3. `anchor build` ile üretilen IDL'in `events` ve `types` bölümleri sözleşme IDL'iyle aynıdır; program
   `scripts/ci/programs.mjs`'te `contract` olunca CI bunu denetler (BC-13).
