# square_registry

Akışın 2. adımı: agent kaydolur ve `did:aip` olarak çözümlenir ([did:aip v2 Solana profili](../../docs/did-aip/method-spec-v2-solana.md)).
Kayıt bir A2A agent card'ına işaret eder (`agent_card_uri`) ve kartın SHA-256'sını taşır
(`agent_card_hash`). Zincirde DID metni yoktur: DID küme, program kimliği ve kayıt adresinden türetilir
(profil §4.2/1). Akışın 3. adımında screener servisi cüzdanların sanctions screening sonucunu yazar (BC-27).
Arayüz [program arayüzü §10.1](../../docs/design/program-interface.md#101-square_registry)'dedir; IDL'i sözleşme
IDL'iyle (`idl/square_registry_contract.json`) aynıdır.

| Talimat | Ne yapar |
|---|---|
| `register_agent` | `AgentRecord`'u açar (`["agent", creator, agent_id]`); imzalayan `owner` hem `creator` hem ilk sahiptir, `status = Active` |
| `update_agent` | Kart işaretçisini, hash'ini ve agent cüzdanını değiştirir |
| `set_agent_status` | `Active` ↔ `Inactive`; `Deregistered` bu talimatla verilemez |
| `transfer_agent_ownership` | Sahibi değiştirir ve `wallet`'ı yeni sahibe sıfırlar; adres `creator`'dan türediği için değişmez |
| `deregister_agent` | `status = Deregistered`: kalıcıdır, hesap kapatılmaz, aynı (creator, agent_id) yeniden kaydedilemez |
| `init_registry_config` | Tekil `RegistryConfig`'i (`["registry_config"]`) açar: `admin`, `screener_authority`, `screening_ttl_secs`. Yalnızca programın yükseltme yetkilisi çağırır (`program` + `program_data`), ilk çağıranın config'i ele geçirmesi önlenir |
| `update_registry_config` | `admin` screener'ı ve kayıt ömrünü değiştirir |
| `record_screening` | Screener, cüzdanın sonucunu `ScreeningRecord`'a (`["screening", wallet]`) yazar: `status`, `source_hash`, `screened_at`, `expires_at = screened_at + screening_ttl_secs`. Cüzdan başına tek kayıt; her screening öncekinin üzerine yazar, rent'i `payer` öder |

Kurallar (profil §4.1, §4.2):

- `agent_id`: `[A-Za-z0-9_-]{1,32}`, değişmez. Boş ya da alfabe dışı kimlik `AgentIdInvalid` alır. 32 baytı
  aşan kimlikle PDA türetilemez; Anchor `init`'in seed'lerini kimlik kısıtından önce türettiği için işlem
  `ProgramFailedToComplete` ile durur ve kayıt oluşmaz. SDK'nın `pda.agentRecord`'u bu kimliği istemcide reddeder.
- Kart ve hash birlikte yazılır: boş URI ↔ sıfır hash (`AgentCardHashInvalid`); URI en fazla 200 bayt.
- Kaydı yalnızca güncel sahip değiştirir (`has_one = owner`). Sahip bir PDA olabilir, ör. Squads vault'u.
- `Deregistered`'dan sonra hiçbir talimat kaydı değiştiremez (`AgentDeregistered`).

Screening kuralları (BC-27, program arayüzü §4):

- Kaydı yalnızca config'teki `screener_authority` yazar (`has_one`, `Unauthorized`); TTL pozitif olmalıdır
  (`InvalidScreeningTtl`).
- Escrow kaydı `fund_job`'da (kurum ve agent), `buy_claim`'de (alıcı) ve release'te (payee) okur: hesap
  registry'nin PDA'sı, durum `Clear`, `expires_at > now`. Kural `square_common::screening::require_clear`'dadır;
  reddin sebebi (`Missing`, `Flagged`, `Expired`) escrow'un `ScreeningRequired`, `ScreeningFlagged`,
  `ScreeningExpired` kodlarına karşılık gelir.

Event'ler `square_common::square_registry_events!()` ile tanımlanır ([event şeması](../../docs/design/events.md));
her talimat kendi event'ini yayımlar. Event'ler kayıt adresini taşır, DID'i değil. `RegistryConfigUpdated`
config'in kurulmasında ve her güncellemesinde yayımlanır.

## Testler

```bash
anchor build -p square_registry
cargo test --manifest-path tests/programs/Cargo.toml --test registry --test screening
```

Testler ([`registry.rs`](../../tests/programs/tests/registry.rs), [`screening.rs`](../../tests/programs/tests/screening.rs))
derlenmiş programı LiteSVM'de çalıştırır ([`tests/programs`](../../tests/programs/)):

- kayıt alanları, zincirde DID metninin olmaması ve `AgentRegistered`;
- kartsız (boş URI, sıfır hash) kayıt; kimlik alfabesi ve uzunluğu; kart / hash birlikteliği ve URI sınırı;
- çift kayıt; aynı kimliğin başka creator altında ayrı kayıt olması;
- güncelleme ve `AgentUpdated`; yabancı imzacının dört değiştirici talimatta da reddi;
- duraklatma / sürdürme ve `AgentStatusChanged`; `set_agent_status(Deregistered)` reddi;
- devir: adres ve `creator` aynı, `wallet` yeni sahip, eski sahip yetkisiz, `AgentOwnershipTransferred`;
- kalıcı kayıt silme: hesap durur, sonrasındaki her talimat ve yeniden kayıt reddedilir, `AgentDeregistered`;
- Squads vault'unun sahip olarak kaydetmesi ve yönetmesi;
- config'i yalnızca yükseltme yetkilisinin kurması, pozitif olmayan TTL'in reddi, tek kurulum ve
  `RegistryConfigUpdated`;
- kaydı yalnızca screener'ın yazması, alanlar ve `ScreeningRecorded`; aynı cüzdanın yeniden screening'inin
  kaydın üzerine yazması;
- admin'in screener'ı ve ömrü değiştirmesi, eski screener'ın reddi;
- escrow okuması (`square_common::screening`) programın yazdığı hesapla: temiz ve tazeyken geçer, ömrün
  sonunda `Expired`, işaretliyken `Flagged`, başka cüzdan için `Missing`.

## Köken

AIP `programs/aip-escrow/programs/aip-registry`'den geçmişiyle taşındı (BC-07); BC-15 ile Square
arayüzüne göre yeniden yazıldı. Kaynak lisansı: [`LICENSE`](LICENSE).
