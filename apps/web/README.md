# apps/web — `@squaresdk/solana-web`

Square'in web uygulaması: Next.js 16 (App Router), React 19, Tailwind CSS 4 ve `@solana/wallet-adapter-react` ([§12.4](../../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)). Şu an iskelet (FE-01), tasarım sistemi (FE-02) ve landing (FE-15) var. 8 adımın sayfaları M4'te gelir.

| Rota | İçerik |
|---|---|
| `/` | Landing: değer önerisi, 8 adımlı akış, programlar ve ağ (canlı); bütün butonlar uygulamaya gider |
| `/app` | Uygulama: bağlı cüzdanın adresi, SOL ve USDC bakiyesi, ağın canlı durumu ve doğrulaması, rol seçimi |
| `/app/policy` | Kurumun harcama politikası: sır, kural editörü, alıcı listesi, zincire gidecek değerler (FE-04) |
| `/app/agent` | Agent kaydı: kimlik, DID ve kayıt adresi tx'ten önce, kartın indirilip doğrulanması, `register_agent` (FE-05) |
| `/app/did` | did:aip çözümü: kayıt zincirden, kart kendi adresinden; DID belgesi ve meta verisi. `?did=` ile paylaşılır (FE-05) |
| `/app/jobs/new` | İş açma ve fonlama: agent, tutar, deadline, challenge süresi, politika bağlama, iş tanımı ve hash'i, iki tarafın screening'i, `create_job` + `fund_job` (FE-06) |
| `/app/jobs/[job]` | İş detayı: zincirdeki job, event'lerden canlı zaman çizelgesi, zincir saatine göre challenge sayacı; agent cüzdanı için kabul ve teslim (FE-07); alacağın listelenmesi, geri çekilmesi ve onaylı alıcının alımı, payee (FE-08); uyum ispatının durumu, kurumun ispatı üretip bağlaması (FE-09) |
| `/app/claims` | Alacak piyasası: satıştaki alacaklar, fiyat, iskonto, kimin alabileceği (FE-08) |
| `/design` | Bileşen kataloğu |
| `/healthz` | Sağlık kontrolü (Railway) |

## Yapılandırma

Değerler ortamdan gelir ve kök layout'ta **istek anında, sunucuda** okunur (`connection()`), derlemeye gömülmez. Aynı derleme her ortamda kendi değerleriyle çalışır. Kodda varsayılan ağ ya da RPC adresi yoktur. Değişkenlerden biri eksik ya da geçersizse uygulama yerine hangi değişkenin neden reddedildiğini gösteren bir yapılandırma sayfası açılır.

| Değişken | Değer |
|---|---|
| `SQUARE_SOLANA_CLUSTER` | `devnet`, `testnet`, `mainnet-beta` ya da `localnet` |
| `SQUARE_SOLANA_RPC_URL` | O cluster'ın JSON-RPC ucu; `https` (yalnızca `localnet` için `http`). WebSocket ucu web3.js tarafından bundan türetilir |
| `SQUARE_PROVER_URL` | İsteğe bağlı: release ispatını üreten prover servisinin kök adresi ([`apps/prover`](../prover/README.md)); `https` (yalnızca `localnet` için `http`). Tanımlı değilse kurum iş sayfasında ispat üretemez, ispatın durumu yine görünür. Prover'ın `CORS_ORIGINS`'i web'in adresini içermeli |
| `SQUARE_PROGRAM_ID_{REGISTRY,POLICY,VERIFIER,ESCROW}` | İsteğe bağlı: programların o cluster'daki adresi (db ile aynı adlar; IDL'deki adres kullanılmaz). Tanımlı olan program landing'de adresi ve zincirdeki deploy durumuyla, tanımlı olmayan "Not configured" olarak görünür. USDC bakiyesi escrow'un config'inden okunduğu için `ESCROW` gerekir. Geçersiz bir değer yapılandırma hatasıdır |

RPC adresi istemci bileşenine (`ConnectionProvider`) gider, yani tarayıcıya iner: ekranda yalnızca host gösterilse de sayfa yükünde görünür. İçinde API anahtarı olan bir RPC kullanılacaksa ya alan adıyla kısıtlanmış (domain allowlist'li) bir anahtar ya da anahtarı sunucuda tutan bir vekil gerekir.

## Cüzdanlar

- Phantom ve Solflare adapter'ları açıkça kayıtlıdır: kurulu değillerse modal kurulum bağlantısını gösterir.
- Backpack ve diğer Wallet Standard cüzdanları kuruluysa otomatik algılanır. Backpack'in ayrı bir wallet-adapter paketi yoktur. Kurulu Phantom ve Solflare de Wallet Standard ile gelir ve aynı adlı adapter'ın yerini alır.
- `autoConnect` açık: son seçilen cüzdan (`localStorage.walletName`) sayfa açılınca yeniden bağlanır.

## Cüzdan oturumu (FE-03)

| Parça | Davranış |
|---|---|
| Ağ koruması | RPC'nin genesis hash'i kümenin CAIP-2 referansıyla karşılaştırılır (did:aip v2 Solana profili §3.3; değerler `@squaresdk/solana-identity`'de). Uyuşmazsa, RPC'ye ulaşılamazsa ya da bağlı Wallet Standard hesabı kümenin zincirini (`solana:devnet` …) listelemiyorsa her sayfada uyarı çıkar ve işlem kapanır. localnet'te genesis'in public bir kümeye ait olmaması yeterlidir |
| Gönderim | Yazmalar `useSendTransaction()`'dan geçer: korumadan geçmeyen işlem cüzdana gitmez. Cüzdana yalnızca imzalatılır, işlemi ağı doğrulanmış uygulama bağlantısı gönderir. wallet-adapter'ın `sendTransaction`'ı kullanılmaz: Wallet Standard cüzdanlarda zinciri RPC adresinin metninden tahmin eder ve adında `devnet` geçmeyen bir devnet RPC'sini mainnet sayar |
| Bakiyeler | SOL ve USDC, hesap aboneliğiyle canlı. USDC'nin mint'i ortamdan değil, escrow'un `EscrowConfig` hesabındaki `settlement_mint`'ten okunur (işlerin kullanabildiği tek mint). `SQUARE_PROGRAM_ID_ESCROW` tanımlı değilse ya da config init edilmemişse bakiye yerine sebebi görünür |
| Rol | Institution, agent ya da buyer (Square sözlüğü); her rolün adımları 8 adımlı akıştan türetilir. Seçim cüzdan başına, bu tarayıcıda (`localStorage.square-role:<adres>`) tutulur; `useRole()` ile okunur |
| Oturum | Ed25519 imzalı API oturumu, imzalanacak mesajın biçimini belirleyecek BE-18'i (`apps/api`) bekliyor |

## Politika sayfası (FE-04)

Institution rolündeki cüzdan için; `SQUARE_PROGRAM_ID_POLICY` gerekir, çünkü commitment `Institution` PDA'sını (`operator_id_field`) bağlar.

| Parça | Davranış |
|---|---|
| Sır | `generatePolicySecret()` ile 32 bayt; 8 salt'ın tek kaynağı (`derivePolicySalts`). Bu tarayıcıda `localStorage.square-policy-secret:<cüzdan>`'da, şifrelenmeden tutulur; sunucuya gönderilmez |
| Yedek | `square-policy-backup` v1 JSON: sır, taslaklar ve alıcı salt'ları. Yalnızca aynı cüzdana geri yüklenir. Sır kaybolursa ispat üretilemez ve release'ler gerçekleşmez |
| Kurallar | `PolicyDocument`'ın alanları, devrenin sınırlarıyla (`POLICY_CIRCUIT_LIMITS`). Settlement mint'i escrow config'inden biliniyorsa tutarlar USDC olarak girilir: ondalık mint hesabından okunur, çeviri tam sayı aritmetiğiyle (`parseUnits`) yapılır, mint'in ondalığından fazla basamak hatadır, taban birim karşılığı yanında gösterilir. Mint bilinmiyorsa alanlar taban birimdedir. Taslakta tutarlar her zaman taban birimdir. Whitelist'te settlement mint'in olup olmadığı da gösterilir. Public tavan 0 ya da whitelist'te settlement mint yoksa uyarı verilir |
| Alıcılar | Satır başına bir cüzdan; her alıcıya `generateLeafSalt()` ile salt, kök `buildBuyerTree` ile. Boş liste sıfır kök (kısıtsız) |
| Zincire giden | Institution ve Policy PDA'ları, `policy_id`, commitment (`computePolicyCommitment`), `daily_ceiling`, `buyer_root`; hepsi tarayıcıda hesaplanır |
| Commit | Zincirdeki Institution ve Policy hesapları okunur, taslakla karşılaştırılır; yalnızca farklı olan yazılır, tek tx'te ve bu sırayla: kurum yoksa `init_institution` (ad, en fazla 64 bayt), politika yoksa `set_policy`, varsa commitment ya da tavan değiştiyse `update_policy`, kök farklıysa `set_buyer_root`. Tx `useSendTransaction()` ile imzalanır; ücreti ve rent'i kurum cüzdanı öder. Kapalı politika güncellenmez; Squads multisig'e bağlı kurumun yetkilisi vault'tur, sayfa commit'i kapatır. square_policy hata kodu IDL'deki mesajıyla gösterilir. Hesaplar ağ doğrulanmadan okunmaz |
| Sürüm | Taslağın `version`'ı zincirdeki `Policy.version`'ı izler (`PolicyDocument.version`); commitment sürümü içermez, güncelleme commitment'ı bozmaz |
| Geçmiş | Politika hesabına dokunan son 20 işlemin loglarındaki event'ler (`PolicyCommitted`, `PolicyUpdated`, `BuyerRootCommitted`, `PolicyDeactivated`); indexer gerekmez |
| Alıcı kanıtları | Zincirdeki `buyer_root` taslağın köküyle aynıysa her onaylı alıcı için kanıt dosyası indirilir (FE-08, aşağıda) |

PDA'lar SDK'nın IDL seed'lerinden türetilir (`src/lib/idl-pda.ts`, SDK'nın `createPda`'sıyla aynı adresler; testli). Anchor yalnızca gerektiğinde yüklenir.

## Agent kaydı ve DID çözümü (FE-05)

Kayıt sayfası agent rolündeki cüzdan için; `SQUARE_PROGRAM_ID_REGISTRY` gerekir. Kayıt adresi ve DID bu programın
kimliğinden türetilir. did:aip v1 programının kimliği (`CgchXu…Vbc`) reddedilir: v2 registry'si olarak çözülmez
(did:aip v2 Solana profili §6.1 adım 4, §9.2).

| Parça | Davranış |
|---|---|
| Kimlik | `agent_id` `[A-Za-z0-9_-]{1,32}` (profil §3.4, §4.1); değişmez ve silinse de yeniden kullanılamaz |
| DID | `did:aip:solana:{chain-ref}:{registry}:{agent_record}`; `chain-ref` doğrulanmış RPC'nin genesis hash'inden. Ağ doğrulanmadan türetilmez. Tx onaylanmadan DID var sayılmaz (§7.1) |
| Kayıt | `AgentRecord` (`["agent", creator, agent_id]`) zincirden okunur: aynı cüzdan aynı kimliği ikinci kez kaydedemez |
| Kart | Önce yayımlanır, sonra kaydedilir (§7.1). Tarayıcı kartı kendi adresinden indirir (https, yönlendirme yok, 256 KiB, 10 s; sunucusu cross-origin isteğe izin vermeli), `AgentCardSchema` ile doğrular ve kartın `registrations` listesinde bu kaydın girdisini arar. Girdi sayfada hazır verilir. Hash, indirilen baytların SHA-256'sıdır. URI boşsa kartsız kayıt (sıfır hash) |
| Cüzdan | Varsayılan olarak bağlı cüzdan; kabul, teslim ve alacak listelemeyi imzalar, ödemeyi alır |
| Tx | `register_agent` registry IDL'iyle kurulur, `useSendTransaction()` ile imzalanır; ücreti ve rent'i sahibi öder. Registry hata kodu IDL'deki mesajıyla gösterilir |
| Çözüm | `@squaresdk/solana-identity`'nin `resolveDid`'i uygulamanın bağlantısıyla: başka bir ağın DID'i `unsupportedChain`. Kart durumu (doğrulandı, yok, ulaşılamadı, hash uyuşmuyor, geçersiz), sahip, agent cüzdanı, kayıt ve güncelleme zamanı, okunan slot, servisler ve DID belgesi |

Profil sayfasındaki itibar, validation geçmişi ve işler ile agent dizini, indexer ve API'yi (BE-14, BE-18) bekliyor.

## İş açma ve fonlama (FE-06)

Institution rolündeki cüzdan için; yalnızca `SQUARE_PROGRAM_ID_ESCROW` gerekir. Registry, policy ve verifier
programlarının kimlikleri, challenge süresi sınırları ve settlement mint'i escrow'un `EscrowConfig`
hesabından okunur (program arayüzü §4). Tx'ler SDK'nın akışıyla (`flow.createJob`, `flow.fundJob`) kurulur.

| Parça | Davranış |
|---|---|
| Agent | did:aip v2 Solana DID'i ya da `AgentRecord` adresi. DID bu ağın ve escrow'un okuduğu registry'nin olmalı; kayıt zincirden okunur, yalnızca etkin agent iş alır. Ödeme kaydın `wallet`'ına |
| Şartlar | Tutar USDC olarak (mint'in ondalığıyla), deadline yerel saatle, challenge süresi dakika olarak config'in sınırlarında. Politika, bu tarayıcıda commit edilmiş etkin politikalardan seçilir (FE-04); bağlanırsa release ispata bağlanır. Tutar politikanın public tavanını aşarsa uyarı |
| İş tanımı | JSON nesnesi; A2A ile agent'a gider, zincire yalnızca RFC 8785 kanonik biçiminin SHA-256'sı (`spec_hash`). Job adresi kurum + hash'ten türer; aynı tanımla açılmış iş varsa durumu gösterilir ve fonlanabilir |
| Screening | Kurumun ve agent cüzdanının `ScreeningRecord`'u, escrow'un kuralıyla (`square_common::screening`): kayıt yok, işaretli, süresi dolmuş. Biri temiz değilse fonlama kapanır ve hangi cüzdanın neden kapattığı yazılır; program yine reddederse `ScreeningRequired` / `ScreeningExpired` / `ScreeningFlagged` aynı açıklamayla gösterilir, iş açık kalır |
| Fonlama | Kurumun USDC bakiyesi yetmiyorsa ya da tutar Travel Rule eşiğindeyse (BC-34) fonlama kapanır |
| Tx | İki tx, kurum cüzdanının imzasıyla: `create_job` (iş ve vault), `fund_job` (tutar vault'a). Escrow hata kodu IDL'deki mesajıyla. Hesaplar ağ doğrulanmadan okunmaz |

## İş detayı (FE-07)

Herkese açık; eylemler bağlı cüzdana göre açılır. Yalnızca `SQUARE_PROGRAM_ID_ESCROW` gerekir.

| Parça | Davranış |
|---|---|
| Job | Escrow `Job` hesabı: durum, tutar, kurum, agent (DID çözümüne bağlantı), ödeme cüzdanı (alacak satıldıysa alıcı, değilse agent cüzdanı; iade edilen ya da iptal edilen işte kurum), deadline, challenge süresi, politika ve sürümü, `spec_hash`, teslimde URI ve `work_hash` |
| Zaman çizelgesi | Job hesabına ve alacak listelemesine (`["claim", job]`) dokunan son 50 işlemin loglarındaki escrow event'leri (`JobCreated` … `Finalized`, alacak ve uyuşmazlık event'leri), eskiden yeniye; yalnızca bu job'un ve escrow programının event'leri. Listelemenin geri çekilmesi (`cancel_claim`) yalnızca listelemeye dokunduğu için iki adres de izlenir. İki adresten birini anan her onaylı işlemde job, listeleme ve zaman çizelgesi yeniden okunur: log aboneliği (`onLogs`, WebSocket) anında bildirir; abonelik kurulamaz ya da koparsa iki adresin en yeni imzası 5 saniyede bir yoklanır (sekme görünürken). Aynı işlem ikisinden de gelirse bir kez okunur |
| Challenge sayacı | `challenge_end` zincir saatine göre: Clock sysvar'ının `unix_timestamp`'i okunur (dakikada bir yeniden), aradaki saniyeler yerel saatle ilerler. Escrow'un kuralıyla `challenge_end`'te kapanır |
| Agent | Bağlı cüzdan job'un `agent_wallet`'ıysa: fonlanmış işte `accept_job`; kabul edilmiş işte teslim dosyası tarayıcıda hash'lenir (SHA-256, SDK `workHash`; dosya yüklenmez), teslim URI'si en fazla 128 bayt, deadline'dan önce `submit_work`. Escrow hata kodu IDL'deki mesajıyla |
| Ağ | Job, zaman çizelgesi, saat ve log aboneliği ağ doğrulanmadan açılmaz |

## Alacak piyasası (FE-08)

Agent, teslim edilmiş işin alacağını (release'teki ödemeyi alma hakkı) iskontolu satar; alıcı fiyatı hemen öder, release'te escrow'un neti ona gider ([ADR 0014](../../docs/decisions/0014-alacak-piyasasi-satici-ve-alici-kurallari.md)). Yalnızca `SQUARE_PROGRAM_ID_ESCROW` gerekir; registry ve policy kimlikleri escrow config'inden gelir.

| Parça | Davranış |
|---|---|
| Piyasa (`/app/claims`) | Zincirdeki `Listed` listelemeler (`getProgramAccounts`, `status` baytına `memcmp`), işleri ve politikalarıyla; yalnızca satılabilir olanlar (iş `Delivered`, satıcı job'un güncel agent cüzdanı), en yeni önce. Fiyat, release'teki ödeme, iskonto, kimin alabileceği, release'in ispata bağlı olup olmadığı. Alım iş sayfasında |
| Listeleme | İş sayfasında, bağlı cüzdan job'un `agent_wallet`'ı ve iş `Delivered`'sa: fiyat `0 < fiyat < yüz değer` (`InvalidClaimPrice`), iskonto gösterilir, `list_claim`. Satıcı `Listed` listelemeyi geri çeker (`cancel_claim`; rent ödeyene döner). Cüzdan rotasyonundan kalan eski listeleme satılamaz ve bunu gösterir |
| Onaylı alıcılar | Kök alım anında politikanın güncel hâlinden okunur. Politikasız iş ve sıfır kök kısıtsızdır (kanıt gerekmez); politikalı işte kök sıfırken alıcıya risk gösterilir: kurumun politikası onu engelliyorsa release kuruma iade eder ve ödenen fiyat kaybolur |
| Kanıt dosyası | `square-buyer-proof` v1 JSON: küme, politika, kök, alıcı, alıcının `leaf_salt`'ı ve Merkle kanıtı; diğer alıcıların salt'larını taşımaz. Kurum politika sayfasından indirir (liste zincirdekiyle aynıyken), alıcı iş sayfasında yükler. Dosya tarayıcıda zincirdeki güncel köke karşı denetlenir; başka cüzdanın, başka politikanın ya da kümenin dosyası ve eski listeden kalan dosya ayrı mesajla reddedilir, listede olmayan cüzdana "Your wallet is not on the institution's approved buyer list." |
| Alım | Satıcı ve işi fonlayan kurum alamaz. Alıcının screening'i temiz ve taze, USDC bakiyesi fiyata yetiyor ve kanıt geçerliyse `buy_claim` (fiyat listelemeninki; öne geçme koruması). Escrow hata kodu IDL mesajıyla ve ne yapılacağıyla (`BuyerNotEligible`, screening kodları, `ClaimPriceChanged`) |
| Payee | Alacak satıldıysa alıcı, değilse agent cüzdanı (SDK `payeeOf` ile aynı kural); iş sayfasında "Paid to" satırı canlı güncellenir |

## Uyum ispatı ve release durumu (FE-09)

Politikaya bağlı işte escrow, kurumun bağladığı release ispatına (`ReleaseProof`, square_verifier) göre öder, iade eder ya da bekler ([ADR 0012](../../docs/decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md), [ADR 0013](../../docs/decisions/0013-release-keeper-ucreti-iade-ve-itibar.md)). İş sayfasının "Compliance proof" bölümü:

| Parça | Davranış |
|---|---|
| Durum | Herkese açık. İspat yoksa finalize bekler (`ProofRequired`). Varsa: karar, ret sebepleri (ret kodunun bitleri, [release-circuit.md](../../docs/design/release-circuit.md) §3), ispatın anı, payee, net ve günlük sayaç; escrow'un şimdi finalize'da ne yapacağı: ödeme, kesin retle kuruma iade (bit 0, 2, 3; sayaç 0 iken bit 1, 6) ya da bekleme |
| Tazelik | Zincir saatine göre, escrow'un `check_fresh`'iyle aynı kural: payee (alacak satıldıysa alıcı), net (`amount − keeper ücreti`) ve mint release'inkiyle aynı, release ispatın UTC gününde ve kurumun sayacının etkin değeri ispattakiyle aynı. Bayatsa sebepleri (`StaleReleaseProof`); tazeyse geçerli olduğu son an (UTC gününün sonu) |
| İspat üretme | Bağlı cüzdan işi fonlayan kurumsa ve iş `Delivered` / `Disputed`'sa. Politika ve sır FE-04'ün bu tarayıcıdaki çalışma alanından okunur; job'un snapshot'ıyla (commitment, public tavan) aynı olmalı. Witness zincir saatiyle kurulur (`buildReleaseWitness`), ispatı prover servisi üretir (`createRemoteProver`, `x-api-key`; anahtar yalnızca sayfada tutulur). Beklenen artefakt sürümü devrenin manifest'indeki zkey SHA-256'sı. Prover'ı işleten politikayı görür; sayfa bunu söyler. snarkjs (GPL-3.0) yalnızca `apps/prover`'da çalışır |
| Bağlama | Kurum ispatın kararını (uyumlu ya da ret sebepleri, kesin mi geçici mi) görüp `set_compliance_proof`'la bağlar. İspatın anı bağlamada zincir saatine en fazla 600 s uzak olmalı; sayfa kalan süreyi gösterir, süre geçince yenisini ister. Squads vault'a bağlı kurumda bağlama vault işlemidir, sayfa bunu söyler. Verifier hata kodu IDL mesajıyla |
| Zaman çizelgesi | `ReleaseVerified` (payee ve net), `ReleaseRefused` (iade ve sebepleri) |

## Tasarım sistemi

Görsel kimlik Arc Square'den referans alınır, kod taşınmaz (§12.4).

| Parça | Yer |
|---|---|
| Renk token'ları, açık ve koyu tema | `src/styles/theme.css`: Arc paleti anlamsal adlara (`--sq-bg`, `--sq-text`, `--sq-accent`, durum tonları, …) eşlenir; koyu tema `[data-theme='dark']`. Tailwind'de `bg-surface`, `text-muted` gibi sınıflar |
| Tipografi | OpenRunde (`@fontsource/open-runde`, OFL-1.1; dosyalar derlemeye dahil); ölçek `text-caption` … `text-display` |
| Tema geçişi | `next-themes`: açık / koyu / sistem; seçim `localStorage.square-theme`'de, ilk karede yanlış tema yok |
| Bileşenler | `src/components/ui/`: `Button`, `StatusBadge`, `Table`, `StepIndicator`, `Address` / `Did`, `TxConfirmation` |
| Zincir durumlarının tonu | `src/lib/status.ts`: değer kümeleri IDL'den üretilen şemalardan (`@squaresdk/solana-types`); yeni bir durum eklenince tonu derleme anında zorunlu |
| Katalog | `/design`: örnek veri yok. Durumlar IDL'den, adımlar protokolden; adres, DID, tablo ve işlem bağlı cüzdandan ve cluster'dan |

Denetimler: `test/contrast.test.ts` iki temadaki her metin / zemin çiftini WCAG 2.2 AA'ya (metin 4.5:1, odak 3:1) göre hesaplar. `test/a11y.test.tsx` her bileşeni axe-core'un WCAG 2.2 A/AA kurallarından geçirir. `test/theme.test.tsx` tema geçişini ve kalıcılığını denetler.

## Komutlar

```bash
pnpm --filter @squaresdk/solana-web dev        # geliştirme sunucusu
pnpm --filter @squaresdk/solana-web build      # üretim derlemesi (env gerekmez); .next/standalone
pnpm --filter @squaresdk/solana-web start      # derlenmiş uygulama (standalone sunucu, üretimdekiyle aynı)
pnpm --filter @squaresdk/solana-web typecheck  # next typegen + tsc
pnpm --filter @squaresdk/solana-web test       # vitest
```

`dev` ve `start` için iki değişkeni ortamda verin ya da `apps/web/.env.local`'a yazın (`.env*` git'e girmez). `start`, PORT'u (varsayılan 3000) ve HOSTNAME'i ortamdan okur.

## Dağıtım: Railway

Web, API ve worker'larla aynı Railway projesinde bir servis olarak çalışır ([ADR 0002](../../docs/decisions/0002-web-hosting-railway.md)).

| Dosya | Görev |
|---|---|
| [`Dockerfile`](Dockerfile) | Build bağlamı repo kökü. `pnpm install --filter @squaresdk/solana-web...` ve derleme; runner imajı yalnızca Next'in standalone çıktısını (~45 MB) taşır, root olmayan kullanıcıyla `node apps/web/server.js` çalıştırır |
| [`Dockerfile.dockerignore`](Dockerfile.dockerignore) | Yerel derleme çıktıları imaja girmez |
| [`railway.json`](railway.json) | Dockerfile yolu, izlenen yollar (yalnızca web'i etkileyen değişiklikler deploy açar), `/healthz` sağlık kontrolü, hata durumunda yeniden başlatma |
| `src/app/healthz/route.ts` | Yapılandırma geçerliyse 200, değilse 503 ve sebepleri (değerleri değil): eksik env'le başlayan bir deploy yayına alınmaz |

Servis ayarları (bir kez, Railway panelinden; hesap erişimi gerekir):

| Ayar | Değer |
|---|---|
| Source | Bu repo; Root Directory **boş** (build bağlamı repo kökü) |
| Railway Config File | `/apps/web/railway.json` (Root Directory'ye göre değil, mutlak yol) |
| Variables | `SQUARE_SOLANA_CLUSTER`, `SQUARE_SOLANA_RPC_URL`; her environment (staging / devnet, production) için ayrı |
| Networking | Public domain; port Railway'in verdiği `PORT` |
| PR Environments | Proje ayarlarında açık; izlenen yollar sayesinde yalnızca web'i etkileyen PR'lar için web deploy'u kurulur |

Yerelde imaj: `docker build -f apps/web/Dockerfile -t square-web .` (repo kökünden), ardından `docker run -p 3000:3000 -e SQUARE_SOLANA_CLUSTER=… -e SQUARE_SOLANA_RPC_URL=… square-web`.
