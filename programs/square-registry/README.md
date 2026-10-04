# square_registry

Akışın 2. adımı: agent kaydolur ve `did:aip` olarak çözümlenir ([did:aip v2 Solana profili](../../docs/did-aip/method-spec-v2-solana.md)).
Kayıt bir A2A agent card'ına işaret eder (`agent_card_uri`) ve kartın SHA-256'sını taşır
(`agent_card_hash`). Zincirde DID metni yoktur: DID küme, program kimliği ve kayıt adresinden türetilir
(profil §4.2/1). Arayüz [program arayüzü §10.1](../../docs/design/program-interface.md#101-square_registry)'dedir;
IDL'i, registry config'i ve screening kayıtları (BC-27) dışında sözleşme IDL'iyle (`idl/square_registry_contract.json`) aynıdır.

| Talimat | Ne yapar |
|---|---|
| `register_agent` | `AgentRecord`'u açar (`["agent", creator, agent_id]`); imzalayan `owner` hem `creator` hem ilk sahiptir, `status = Active` |
| `update_agent` | Kart işaretçisini, hash'ini ve agent cüzdanını değiştirir |
| `set_agent_status` | `Active` ↔ `Inactive`; `Deregistered` bu talimatla verilemez |
| `transfer_agent_ownership` | Sahibi değiştirir ve `wallet`'ı yeni sahibe sıfırlar; adres `creator`'dan türediği için değişmez |
| `deregister_agent` | `status = Deregistered`: kalıcıdır, hesap kapatılmaz, aynı (creator, agent_id) yeniden kaydedilemez |

Kurallar (profil §4.1, §4.2):

- `agent_id`: `[A-Za-z0-9_-]{1,32}`, değişmez. Boş ya da alfabe dışı kimlik `AgentIdInvalid` alır. 32 baytı
  aşan kimlikle PDA türetilemez; Anchor `init`'in seed'lerini kimlik kısıtından önce türettiği için işlem
  `ProgramFailedToComplete` ile durur ve kayıt oluşmaz. SDK'nın `pda.agentRecord`'u bu kimliği istemcide reddeder.
- Kart ve hash birlikte yazılır: boş URI ↔ sıfır hash (`AgentCardHashInvalid`); URI en fazla 200 bayt.
- Kaydı yalnızca güncel sahip değiştirir (`has_one = owner`). Sahip bir PDA olabilir, ör. Squads vault'u.
- `Deregistered`'dan sonra hiçbir talimat kaydı değiştiremez (`AgentDeregistered`).

Event'ler `square_common::square_registry_events!()` ile tanımlanır ([event şeması](../../docs/design/events.md));
her talimat kendi event'ini yayımlar. Event'ler kayıt adresini taşır, DID'i değil.

## Testler

```bash
anchor build -p square_registry
cargo test --manifest-path tests/programs/Cargo.toml --test registry
```

Testler ([`tests/programs/tests/registry.rs`](../../tests/programs/tests/registry.rs)) derlenmiş programı
LiteSVM'de çalıştırır ([`tests/programs`](../../tests/programs/)):

- kayıt alanları, zincirde DID metninin olmaması ve `AgentRegistered`;
- kartsız (boş URI, sıfır hash) kayıt; kimlik alfabesi ve uzunluğu; kart / hash birlikteliği ve URI sınırı;
- çift kayıt; aynı kimliğin başka creator altında ayrı kayıt olması;
- güncelleme ve `AgentUpdated`; yabancı imzacının dört değiştirici talimatta da reddi;
- duraklatma / sürdürme ve `AgentStatusChanged`; `set_agent_status(Deregistered)` reddi;
- devir: adres ve `creator` aynı, `wallet` yeni sahip, eski sahip yetkisiz, `AgentOwnershipTransferred`;
- kalıcı kayıt silme: hesap durur, sonrasındaki her talimat ve yeniden kayıt reddedilir, `AgentDeregistered`;
- Squads vault'unun sahip olarak kaydetmesi ve yönetmesi.

## Köken

AIP `programs/aip-escrow/programs/aip-registry`'den geçmişiyle taşındı (BC-07); BC-15 ile Square
arayüzüne göre yeniden yazıldı. Kaynak lisansı: [`LICENSE`](LICENSE).
