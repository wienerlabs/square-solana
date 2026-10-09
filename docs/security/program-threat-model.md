# Threat model: programlar

**Issue:** BC-39 (#93) · **Kapsam:** dört Square programı (`square_registry`, `square_policy`, `square_verifier`,
`square_escrow`) ve ortak crate `square-common`. Off-chain bileşenler BE-32'dedir ([threat-model.md](threat-model.md)).
**Ağ:** yalnızca devnet ([ADR 0027](../decisions/0027-yalnizca-devnet.md)). İnceleme ve bulgular:
[review-bc-39.md](review-bc-39.md). Hesap kısıtı matrisi: [program-constraints.md](program-constraints.md). Dış
audit paketi: [audit-package.md](audit-package.md).

Yöntem STRIDE'dır: program başına sahte kimlik (S), kurcalama (T), inkâr (R), bilgi sızıntısı (I), hizmet engelleme
(D) ve yetki yükseltme (E). Her tehdidin karşısında programda uygulanan önlem ve onu deneyen test yazılıdır. Önlemi
olmayan ya da yetersiz olan tehdit bir bulgudur.

## 1. Varlıklar

| Varlık | Nerede | Neden değerli |
|---|---|---|
| İşin escrow'u (USDC) | job vault'u: `["escrow_token", job]` token hesabı, yetkilisi job PDA'sı | Doğrudan para |
| Dispute bond'u | bond vault'u: `["bond", job]` | Kurumun teminatı; karara göre bir tarafa gider |
| Alacak | `ClaimListing` (`["claim", job]`) | İşin ödemesini alma hakkı; alıcı fiyatını ödemiştir |
| Program kodu | upgrade authority: 2-of-3 Squads vault ([ADR 0008](../decisions/0008-upgrade-authority-2-of-3-squads.md)) | Kod değişirse bütün varlıklar |
| Config'ler | `EscrowConfig`, `RegistryConfig`, `VerifierConfig`; admin aynı vault | Bağlı program kimlikleri, settlement mint'i, parametreler, arbitrator seti, screener ve MPP authority |
| Uyum kararı | `ReleaseProof`, `OperatorState`, release devresinin doğrulama anahtarı | Ödemenin uyum kapısı ve kurumun günlük harcama sayacı |
| Kimlik ve itibar | `AgentRecord`, `AgentReputation`, `ValidationRecord` | Agent'ın ödeme adresi, itibarı, release kaydı |
| Kurumun yetkisi ve politikası | `Institution`, `Policy` | Kimin ödediği ve hangi kurala bağlandığı |
| Screening kaydı | `ScreeningRecord` (`["screening", wallet]`) | Yaptırım kapısı: fonlama, alım ve ödeme |
| Rent | açılan hesapların lamport'u | Sponsorun ve tarafların SOL'ü |

**Zincirde yetki taşıyan anahtarlar:**

| Anahtar | Yetkisi |
|---|---|
| upgrade authority ve config admin'i | 2-of-3 Squads vault: program kodu, `init_*` / `update_*`, arbitrator seti, screener ve MPP authority rotasyonu |
| screener authority | `ScreeningRecord` yazar (`record_screening`) |
| MPP authority | fiat ödemenin attestation'ını imzalar (Ed25519 precompile, ADR 0024) |
| arbitrator'lar | M-of-N oy (`resolve_dispute`) |
| kurumun yetkilisi | kurum anahtarı ya da bağlı multisig'in vault'u (`Institution.authority()`) |
| agent sahibi ve cüzdanı | kaydın yönetimi; işin kabulü, teslimi ve alacak satışı |
| keeper | permissionless; ücret dışında bir şey almaz |

## 2. Aktörler

- **Roller:** [program arayüzü §2](../design/program-interface.md#2-roller): kurum, agent (sahip ve cüzdan), satıcı ve
  alıcı, arbitrator, keeper, permissionless çağıran, screener, admin, rent ödeyen sponsor.
- **Dış programlar:** SPL Token (settlement mint'i), Associated Token Account, Squads v4, Ed25519 precompile, System.
- **Saldırgan profilleri:**
  - başkasının işinde ya da kaydında talimat imzalayan;
  - hesap ikamesi yapan: başka işin vault'u, bond vault'u, listelemesi, ispatı, başka bir programa ait aynı düzende
    veri;
  - kendi rolünün sınırını zorlayan taraf (kurum, agent, alıcı, arbitrator);
  - anahtarı sızmış taraf (kurum anahtarı, screener, MPP authority, arbitrator);
  - yanlış yapılandıran admin;
  - hizmeti engelleyen: vault'a bağış, hesabın önceden açılması, sınırdaki saniyeler, compute bütçesi.

## 3. Güven sınırları

1. **İmzacı → program:** Anchor `Signer` ve rol kısıtları (`has_one`, `constraint`, `address`). Rol imzacısı ile
   rent ödeyen `payer` ayrıdır (BC-22, BC-35).
2. **Programlar arası okuma:** CPI yerine hesap okuma ([program arayüzü §4](../design/program-interface.md#4-programlar-aras%C4%B1-eri%C5%9Fim)).
   Okuyan program owner'ı, PDA'yı (seed'leri yeniden türeterek) ve discriminator'ı denetler
   (`square_common::account_read`). Okunan programların kimlikleri config'tedir; config'i yalnızca upgrade authority
   açar.
3. **Tek CPI:** escrow → verifier `record_release`. İmzacı escrow'un `["escrow_authority"]` PDA'sıdır; verifier bunu
   `VerifierConfig.escrow_program` ile doğrular.
4. **Token programı:** vault'ların yetkilisi job PDA'sıdır; mint config'in settlement mint'idir.
5. **Squads v4:** hesabın owner'ı Squads v4 ve discriminator'ı `Multisig`; vault PDA'sı Squads'ın türetmesiyle.
6. **Ed25519 precompile:** MPP attestation'ı aynı işlemdeki precompile talimatından, Instructions sysvar'ıyla okunur.
7. **Saat:** Clock sysvar'ı. Pencereler, son tarihler, screening ömrü ve ispat tazeliği ona bağlıdır.
8. **Kod:** upgrade authority (2-of-3) ve verifiable build ([docs/ci.md](../ci.md), BC-13). Zincirdeki hash'lerin
   kaynağa denkliği [review-bc-39.md §5](review-bc-39.md#5-verifiable-build)'tedir.

## 4. Tehditler ve önlemler

### square_escrow

| | Tehdit | Önlem |
|---|---|---|
| S | Başkasının işinde rol talimatı | <ul><li>Kurum talimatları `has_one = institution`, agent talimatları imzacı = `job.agent_wallet` ve `has_one = agent_record`.</li><li>Oy `config.arbitrators[..arbitrator_count]` üyesinden.</li><li>Testler: `escrow_lifecycle.rs`, `dispute.rs`, `claim.rs`.</li></ul> |
| S | Kayıtsız ya da pasif agent'la iş | `AgentRecord` registry'ye ait ve PDA'sı doğru; `Active` (`create_job`, `accept_job`) |
| T | Hesap ikamesi: başka işin vault'u, bond vault'u, listelemesi, ispatı, validation kaydı | <ul><li>Vault, bond vault, listeleme ve validation kaydının seed'leri job'a bağlı.</li><li>`ReleaseProof` `["release_proof", job]` ve verifier'a ait.</li><li>`substitution.rs` (BC-29); her denemede diğer iş etkilenmez.</li></ul> |
| T | Ödemenin başka hesaba yönlendirilmesi | <ul><li>Payee, kurum ve keeper token hesaplarında mint ve owner kısıtları; payee alacak satılmışsa alıcı, değilse `job.agent_wallet` (`settlement::payee`).</li><li>Payee'nin screening'i temiz ve taze değilse ödeme bekler.</li><li>Fuzz: saldırganın hesabı her ödeme yolunda reddedilir ([§6](#6-fuzz-ve-invariant-testi)).</li></ul> |
| T | Tutarların kurcalanması | <ul><li>Keeper ücreti ≤ 100 bps, aşağı yuvarlanır (ADR 0013).</li><li>`Split` tutarı escrow'u aşamaz.</li><li>Bond alt sınırı u128'de hesaplanır.</li><li>`overflow-checks = true`.</li></ul> |
| T | Vault'a bağışla kapanmayı engelleme | Vault'taki fazla `finalize_payment` ve `execute_resolution`'da kuruma döner; `cancel_job` ve `lapse_dispute` vault'u boşaltır. Fuzz invariant'ı: kapanan işin vault'u kalmaz |
| T | Durum makinesini atlama | Her talimat durum ve zaman koşulunu denetler ([program arayüzü §6](../design/program-interface.md#6-escrow-durum-makinesi)); fuzz izinli kenarların dışındaki geçişi yakalar |
| R | Kararın ya da ödemenin inkârı | Her geçiş event yazar; release `ValidationRecord` bırakır (job başına bir) |
| I | Kişisel verinin zincire çıkması | Travel Rule kaydı zincirde yalnızca 32 baytlık commitment'tır (ADR 0015) |
| E | Kurumun teslimden sonra kalıcı retle neti geri alması (BC-39 P-01) | <ul><li>Policy'li işte `accept_job` kurumun ön-ispatını ister: işin kendi koşulları (net tutar, agent cüzdanı, sayaç 0) kalıcı ya da günlük tavan kuralını çiğnemez ([ADR 0028](../decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)).</li><li>Public tavanı aşan iş açılmaz (`AmountAboveDailyCeiling`).</li><li>Kalan tek kesin ret yolu alacağın politikanın engelli listesindeki alıcıya satılmasıdır; alıcının riskidir.</li><li>Testler: `preflight.rs`.</li></ul> |
| D | Dispute ile ödemeyi süresiz geciktirme | <ul><li>İş başına bir dispute; lapse'tan sonra yenisi açılmaz.</li><li>Dispute'un son tarihi (`dispute_timeout_secs`) dolunca `lapse_dispute` bond'u iade eder ve iş normal finalize'a döner.</li></ul> |
| D | Sınırdaki saniyede yarış | Pencere ve son tarih karşılaştırmaları tek yönlüdür (son saniye testleri: `finalize.rs`, `dispute.rs`) |
| E | Admin'in parametreleri kötüye kullanması | <ul><li>Admin upgrade authority'dir (`program_data` ile doğrulanır).</li><li>`config_rules.rs` pencere, ücret ve arbitrator setini sınırlar.</li><li>Üst sınırı olmayan parametreler: [review-bc-39.md](review-bc-39.md).</li></ul> |

### square_verifier

| | Tehdit | Önlem |
|---|---|---|
| S | Sahte release ispatı | Groth16 doğrulaması (alt_bn128 syscall'ları) ve release devresinin doğrulama anahtarı; ispat job'un policy snapshot'ına (commitment, günlük tavan, sürüm) karşı doğrulanır |
| T | İspatın başka işe, payee'ye ya da güne taşınması | <ul><li>`["release_proof", job]`; payee ve mint `Job` / `ClaimListing`'den bağlanır.</li><li>Escrow release anında payee, net tutar, mint ve `daily_spent_before`'u karşılaştırır (`StaleReleaseProof`).</li><li>İspat bir kez tüketilir.</li></ul> |
| T | Ön-ispatın başka işe ya da koşula taşınması | `["preflight_proof", job]`; sinyaller işin kendisinden (net `job.amount`, payee `job.agent_wallet`, sayaç 0, job'un policy snapshot'ı); yalnızca `Open` / `Funded`; escrow `accept_job`'da job, politika, commitment ve payee'yi (işin güncel agent cüzdanı) karşılaştırır; cüzdan taşınınca kurum yeniden bağlar |
| T | Sahte fiat attestation'ı | Önceki talimat Ed25519 precompile, tek imza ve kendi verisinde; imzacı `config.mpp_authority`; mesaj işe, Stripe makbuzunun hash'ine ve tutara bağlı (ADR 0024) |
| E | `record_release`'in escrow dışında çağrılması | İmzacı escrow'un `["escrow_authority"]` PDA'sı; program kimliği config'ten |
| E | Günlük sayacın kurcalanması | `OperatorState` yalnızca `record_release` CPI'ıyla ilerler; ret release'i sayacı ilerletmez |

### square_policy

| | Tehdit | Önlem |
|---|---|---|
| S / E | Kurumun yetkisinin ele geçirilmesi | <ul><li>Yetkili `multisig_vault ?? owner_key`; beş talimat imzacının bu olmasını ister.</li><li>Multisig bağlama: hesap Squads v4'e ait, `Multisig` ve argümanla aynı; vault Squads PDA'sı.</li><li>Bağlamadan sonra kurum anahtarı politikayı değiştiremez (`policy.rs`).</li></ul> |
| T | Politikanın değiştirilip işlerin yeni kurala bağlanması | Commitment, tavan ve sürüm job'a açılışta kopyalanır; sürüm her güncellemede bir artar; kapalı politika yeniden açılmaz |
| T | Alıcı listesinin değiştirilmesi | Yalnızca güncel yetkili, yalnızca politika açıkken; kanıt güncel köke göre değerlendirilir |

### square_registry

| | Tehdit | Önlem |
|---|---|---|
| S | Sahte screening | Yalnızca `RegistryConfig.screener_authority`; kayıt `["screening", wallet]`; ömür config'ten, zincir saatiyle |
| T | Agent cüzdanının değiştirilip ödemenin yönlendirilmesi | Cüzdan job'a açılışta kopyalanır; job'u yeni cüzdana yalnızca kaydın sahibi taşır (`sync_agent_wallet`, `has_one = agent_record`) |
| T | Silinmiş kaydın yeniden kullanımı | `Deregistered` sondur; aynı (oluşturan, `agent_id`) yeniden kaydedilmez, hesap kapanmaz |
| E | Config'in ilk açan tarafından ele geçirilmesi | `init_registry_config` admin'i `ProgramData`'nın upgrade authority'siyle doğrular |

## 5. Kalan riskler

- İç incelemenin bulguları: [review-bc-39.md](review-bc-39.md). Program kodunu değiştiren düzeltmeler ayrı issue'lardır;
  her biri devnet'te Squads upgrade'i ister ([runbook](../runbooks/upgrade.md)).
- Policy'li işlerin ispat kapısı fuzz'da değildir: gerçek Groth16 ispatı ister. Bu dallar `release_gate.rs` ve
  `dispute_gate.rs`'teki deterministik testlerdedir.
- Squads v4, SPL Token ve Ed25519 precompile programlarına güvenilir.
- Admin (2-of-3) güvenilen taraftır; config'in bazı alanları açılıştan sonra değişmez.
- Release devresinin phase-2'si kamusal tören yapılana kadar geliştirme anahtarıdır (BC-38, #92).
- Dış audit yapılmadı (BC-40, BC-41): [audit-package.md](audit-package.md).

## 6. Fuzz ve invariant testi

[`tests/programs/tests/invariants.rs`](../../tests/programs/tests/invariants.rs) escrow'un durum makinesinde tohumlu
rastgele işlem dizileri koşar. Ayrıntılar ve bulduğu sonuçlar: [review-bc-39.md §4](review-bc-39.md#4-fuzz-ve-invariant-testi).
