# square_policy

Akışın 1. adımı: kurum harcama yetkisini (mandate) salt'lı Poseidon commitment'ı olarak zincire yazar.
Politikanın kendisi zincire çıkmaz; zincirde yalnızca commitment ve public günlük tavan durur. Arayüz
[program arayüzü §10.2](../../docs/design/program-interface.md#102-square_policy)'dedir; IDL'i sözleşme
IDL'iyle (`idl/square_policy_contract.json`) aynıdır.

| Talimat | Ne yapar |
|---|---|
| `init_institution` | `authority` için `Institution` hesabını açar (`["institution", owner_key]`) |
| `set_institution_multisig` | Squads v4 multisig'i bağlar; hesabın Squads'a ait, başlatılmış bir `Multisig` olduğu doğrulanır. Sonrasında yalnızca vault PDA'sı yetkilidir |
| `set_policy` | `Policy` hesabını açar (`["policy", institution, policy_id]`): commitment, günlük tavan, `version = 1` |
| `update_policy` | Commitment ve tavanı değiştirir, `version`'ı artırır; mevcut job'lar `create_job` anındaki snapshot'la kalır |
| `deactivate_policy` | Politikayı kapatır; yeni job onu kullanamaz |
| `set_buyer_root` | Onaylı alıcı listesinin kökünü yayımlar (`BuyerRootCommitted`); yaprak `sha256(buyer ‖ leaf_salt)`, sıfır kök kısıtsız. Kök job snapshot'ına girmez, `version` değişmez; escrow `buy_claim` güncel kökü okur |

Yetkili, multisig bağlanana kadar kurum anahtarı (`owner_key`), sonrasında yalnızca multisig'in vault
PDA'sıdır. Event'ler `square_common::square_policy_events!()` ile tanımlanır ([event şeması](../../docs/design/events.md)).
Alıcı listesinin kuralları [program arayüzü](../../docs/design/program-interface.md#alıcı-listesi-merkle-ağacı-set_buyer_root-buy_claim)'ndedir;
kanıt doğrulaması `square_common::merkle`'dedir.

## Testler

```bash
anchor build -p square_policy
cargo test --manifest-path tests/programs/Cargo.toml --test policy
```

Testler [`tests/programs/tests/policy.rs`](../../tests/programs/tests/policy.rs)'tedir ve derlenmiş
programı LiteSVM'de çalıştırır (BC-12 harness'ı):

- politika içeriğinin zincire çıkmaması;
- her güncellemede sürümün artması;
- sıfır tavan, uzun ad ve yetkisiz imzacı reddi;
- kapalı politikanın güncellenememesi;
- multisig bağlama ve bağlandıktan sonra yalnızca vault'un yetkili olması;
- alıcı kökünü yalnızca kurumun güncel yetkilisinin yayımlaması, kapalı politikada reddi, event'i ve
  yayımlanan köke karşı kanıt doğrulaması.

Vault PDA'sının imzası gerçekte Squads programından gelir. Testte bu, imza doğrulaması kapalı LiteSVM'de
vault'un imzacı olarak işaretlenmesiyle canlandırılır.

## Köken

Aperture `programs/policy-registry`'den geçmişiyle taşındı (BC-05); BC-17 ile Square arayüzüne göre
yeniden yazıldı. Kaynak lisansı: [`LICENSE`](LICENSE).
