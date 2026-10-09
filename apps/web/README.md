# apps/web — `@squaresdk/solana-web`

Square'in web uygulaması: Next.js 16 (App Router), React 19, Tailwind CSS 4 ve `@solana/wallet-adapter-react` ([§12.4](../../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)). Şu an iskelet (FE-01), tasarım sistemi (FE-02) ve landing (FE-15) var. 8 adımın sayfaları M4'te gelir.

| Rota | İçerik |
|---|---|
| `/` | Landing: değer önerisi, 8 adımlı akış, programlar ve ağ (canlı); bütün butonlar uygulamaya gider |
| `/app` | Uygulama: bağlı cüzdanın adresi, SOL ve USDC bakiyesi, ağın canlı durumu ve doğrulaması, rol seçimi; seçilen rolün paneli: kurumun işleri, politikaları ve günlük tavan kullanımı, agent'ın işleri, kazancı ve itibarı, alıcının alacakları (FE-11) |
| `/app/network` | Ağ durumu: programların deploy durumu ve upgrade authority'si, config hesapları sözleşmedeki alanlarıyla, keeper ücreti, Square ALT'ı, API'nin hazırlığı (FE-11) |
| `/app/policy` | Kurumun harcama politikası: sır, kural editörü, alıcı listesi, zincire gidecek değerler (FE-04) |
| `/app/agent` | Agent kaydı: kimlik, DID ve kayıt adresi tx'ten önce, kartın indirilip doğrulanması, `register_agent` (FE-05) |
| `/app/did` | did:aip çözümü: kayıt zincirden, kart kendi adresinden; DID belgesi ve meta verisi. `?did=` ile paylaşılır (FE-05) |
| `/app/agents` | Agent dizini: beceri, fiyat ve tamamlanmış iş filtresi, sıralama (FE-05) |
| `/app/agents/[agentRecord]` | Agent profili: kayıt ve kart, beceriler ve fiyatlar, itibar, validation geçmişi, işler (FE-05) |
| `/app/jobs/new` | İş açma ve fonlama: agent, tutar, deadline, challenge süresi, politika bağlama, iş tanımı ve hash'i, iki tarafın screening'i, `create_job` + `fund_job` (FE-06); eşik üstünde Travel Rule formu ve `commit_travel_rule` (FE-18); ödeme rayı: USDC escrow ya da kartla USD, `create_fiat_job` (FE-20) |
| `/app/jobs/[job]` | İş detayı: zincirdeki job, event'lerden canlı zaman çizelgesi, zincir saatine göre challenge sayacı; kurumun kabul öncesi ön-ispatı (P-01); agent cüzdanı için kabul ve teslim (FE-07); alacağın listelenmesi, geri çekilmesi ve onaylı alıcının alımı, payee (FE-08); uyum ispatının durumu, kurumun ispatı üretip bağlaması (FE-09); herkesin tetikleyebildiği finalize, ödeme, validation, itibar ve keeper günlüğü (FE-10); Travel Rule durumu, commitment ve API'de saklanan kayıtla doğrulama (FE-18); uyuşmazlık: itiraz, ispatsız bekleme başvurusu, oy durumu ve son tarih, kararın ödenmesi, lapse (FE-17); fiat işte kartla ödeme: ödeme öncesi politika denetimi, kartla ya da kayıtlı kartla ödeme, makbuz, ispatın bağlanması ve finalize (FE-20) |
| `/app/arbitration` | Arbitrator konsolu: açık dispute'lar, kanıtlar, oylar, oy ve webhook abonelikleri; navigasyonda arbitrator rolünde görünür (FE-17) |
| `/app/claims` | Alacak piyasası: satıştaki alacaklar, fiyat, iskonto, kimin alabileceği (FE-08) |
| `/audit/[job]` | Denetim görünümü: job'un herkese açık uyum geçmişi; event'ler ve işlemleri, ispatın kararı ve geçmişi, validation kaydı. Politikanın içeriği yok (FE-12) |
| `/app/developers` | Geliştirici portalı: API oturumu, API anahtarları, x402 ücretli uç noktalar ve kullanımı, SDK örnekleri (FE-22) |
| `/design` | Bileşen kataloğu |
| `/healthz` | Sağlık kontrolü (Railway) |

## Yapılandırma

Değerler ortamdan gelir ve kök layout'ta **istek anında, sunucuda** okunur (`connection()`), derlemeye gömülmez. Aynı derleme her ortamda kendi değerleriyle çalışır. Kodda varsayılan ağ ya da RPC adresi yoktur. Değişkenlerden biri eksik ya da geçersizse uygulama yerine hangi değişkenin neden reddedildiğini gösteren bir yapılandırma sayfası açılır.

| Değişken | Değer |
|---|---|
| `SQUARE_SOLANA_CLUSTER` | `devnet`, `testnet`, `mainnet-beta` ya da `localnet` |
| `SQUARE_SOLANA_RPC_URL` | O cluster'ın JSON-RPC ucu; `https` (yalnızca `localnet` için `http`). WebSocket ucu web3.js tarafından bundan türetilir |
| `SQUARE_PROVER_URL` | İsteğe bağlı: release ispatını üreten prover servisinin kök adresi ([`apps/prover`](../prover/README.md)); `https` (yalnızca `localnet` için `http`). Tanımlı değilse kurum iş sayfasında ispat üretemez, ispatın durumu yine görünür. Prover'ın `CORS_ORIGINS`'i web'in adresini içermeli |
| `SQUARE_API_URL` | İsteğe bağlı: Square API'nin kök adresi ([`apps/api`](../api/README.md)); `https` (yalnızca `localnet` için `http`). Keeper günlüğü buradan okunur, cüzdan oturumu buradan açılır, teslim dosyası buraya yüklenir (FE-10, FE-03, FE-07); dispute kanıtı, arbitrator kuyruğu, oy tx'i, webhook abonelikleri ve geliştirici portalı (`/app/developers`) buradan gelir (FE-17, FE-22). Kartla ödeme (Stripe'ın yayımlanabilir anahtarı, ödeme, makbuz, kayıtlı kart) buradan gider (FE-20). Tanımlı değilse sayfa bunu söyler: kurum yalnızca kanıtın hash'iyle itiraz eder, arbitrator konsolu ve geliştirici portalı kapanır. Sondaki eğik çizgi atılır. API'nin `CORS_ORIGINS`'i web'in adresini, `API_AUTH_DOMAIN`'i web'in host'unu (`location.host`, ör. `app.example.com`) içermeli |
| `SQUARE_FEE_PAYER_URL` | İsteğe bağlı: sponsorlu işlem servisinin kök adresi ([`apps/fee-payer`](../fee-payer/README.md), BE-27); `https` (yalnızca `localnet` için `http`). Sponsorlu gönderim ve smart account ([aşağıda](#smart-account-ve-sponsorlu-işlem-fe-21)) bunu ister. Servis Square API'nin oturumunu kabul ettiği için `SQUARE_API_URL` de gerekir. Sondaki eğik çizgi atılır. Servisin `CORS_ORIGINS`'i web'in adresini içermeli |
| `SQUARE_PROGRAM_ID_{REGISTRY,POLICY,VERIFIER,ESCROW}` | İsteğe bağlı: programların o cluster'daki adresi (db ile aynı adlar; IDL'deki adres kullanılmaz). Tanımlı olan program landing'de adresi ve zincirdeki deploy durumuyla, tanımlı olmayan "Not configured" olarak görünür. USDC bakiyesi escrow'un config'inden okunduğu için `ESCROW` gerekir. Geçersiz bir değer yapılandırma hatasıdır |
| `SQUARE_LOOKUP_TABLE` | İsteğe bağlı: Square address lookup table'ı (BC-28; servislerde `API_LOOKUP_TABLE`, devnet'teki [kayıt](../../docs/deploy/devnet.md#square-alt)). Ağ sayfası tablonun durumunu ve içeriğinin SDK'nın beklediği adreslerle aynı olup olmadığını gösterir; tanımlı değilse bunu söyler. Geçersiz bir değer yapılandırma hatasıdır |

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
| Rol | Institution, agent, buyer ya da arbitrator (Square sözlüğü); her rolün adımları 8 adımlı akıştan türetilir, arbitrator akışın dışındadır (uyuşmazlık). Seçim cüzdan başına, bu tarayıcıda (`localStorage.square-role:<adres>`) tutulur; `useRole()` ile okunur |
| Oturum | Square API'ye cüzdanla giriş (`useApiSession()`): API'nin Sign-In With Solana mesajı (`createAuthChallenge`) cüzdana imzalatılır (`signMessage`; işlem değil), imza oturum belirtecine çevrilir (`createSession`). Mesaj imzadan önce denetlenir: ilk satırındaki alan adı sayfanın host'u, ikinci satırı bağlı cüzdan değilse imzalatılmaz. Belirteç yalnızca bellekte, bağlı cüzdana bağlı tutulur; cüzdan değişince ya da bağlantı kopunca bırakılır ve API'de kapatılır (`deleteSession`). Yenileme: API'de yenileme ucu olmadığı için yeni bir imzadır; bitmesine 60 saniyeden az kalan oturum oturum gereken bir sonraki istekte yeniden imzalatılır, API eldeki oturumu reddederse (`unauthorized`: süresi dolmuş ya da kapatılmış) bir kez yeniden imzalatılıp istek tekrarlanır. `/app`'te durumu, bitişi, açma ve kapatma |

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
| Kartı Square API'de barındırma | `SQUARE_API_URL` tanımlıysa kartın JSON'u yapıştırılır ya da dosyadan yüklenir; şema ve kayıt girdisi yazarken denetlenir. "Host the card" cüzdan oturumuyla (FE-03) `putAgentCard`'ı kayıttan önce, `agentId` ile çağırır. API şemadan geçmiş kartın RFC 8785 kanonik JSON'unu saklar ve A2A keşif yolunu (`/a/{agentRecord}/.well-known/agent-card.json`) döner. Tarayıcı aynı baytların SHA-256'sını kendisi hesaplar: API'nin hash'i farklıysa URI kayda yazılmaz. Girdi şemanın okuduğu biçimden farklıysa (şemada olmayan alan, eksik varsayılan) sayfa bunu söyler. Barındırılan kart dizinde becerileri ve fiyatlarıyla görünür |
| Cüzdan | Varsayılan olarak bağlı cüzdan; kabul, teslim ve alacak listelemeyi imzalar, ödemeyi alır |
| Tx | `register_agent` registry IDL'iyle kurulur, `useSendTransaction()` ile imzalanır; ücreti ve rent'i sahibi öder. Registry hata kodu IDL'deki mesajıyla gösterilir |
| Çözüm | `@squaresdk/solana-identity`'nin `resolveDid`'i uygulamanın bağlantısıyla: başka bir ağın DID'i `unsupportedChain`. Kart durumu (doğrulandı, yok, ulaşılamadı, hash uyuşmuyor, geçersiz), sahip, agent cüzdanı, kayıt ve güncelleme zamanı, okunan slot, servisler ve DID belgesi |

### Dizin ve profil

Square API'den (`SQUARE_API_URL`) okunur: indexer (BE-14) registry'yi, itibarı ve işleri zincirden yansıtır, kartları API barındırır (`putAgentCard`). Ağ doğrulanmadan okunmaz.

| Parça | Davranış |
|---|---|
| Dizin | `listAgents`, sayfa başına 200, en fazla 1.000 agent; varsayılan olarak yalnızca etkin agent'lar. Beceri filtresi API'de: kartlardaki beceri kimliği ya da etiketiyle birebir eşleşme. Fiyat ve en az tamamlanmış iş filtresi okunan agent'lar üzerinde, yazarken; 1.000'den fazla agent varsa sayfa bunu söyler |
| Fiyat | Kartın `pricing`'i, settlement mint'inin biriminde (`EscrowConfig.settlement_mint`, USDC): beceri arandıysa ona uyan becerilerin, yoksa bütün becerilerin en düşük fiyatı. Başka mint'teki fiyat karşılaştırılmaz. Fiyat sınırı varken fiyatı olmayan agent görünmez |
| Sıralama | En çok tamamlanmış iş (eşitlikte kazanç), en düşük fiyat, en yeni kayıt |
| Ağ | Agent'ın DID'indeki zincir referansı ve registry kimliği bu ağınkiyle (genesis hash'i, `SQUARE_PROGRAM_ID_REGISTRY`) karşılaştırılır: API başka bir kümenin ya da eski bir registry'nin indexer'ını okuyorsa o agent'lar gösterilmez ve sayısı yazılır |
| Profil | `getAgent` ve `listJobs({ agentRecord })`: kart (adı, açıklaması, A2A ucu, sağlayıcı; SHA-256'sı kayıtla eşleşiyor mu), beceriler ve fiyatları, itibar (`AgentReputation`: tamamlanan, başarısız, uyuşmazlıklı iş, kazanç, ilk ve son settlement), validation geçmişi (settlement'ı yazılmış işlerin `ValidationRecord`'u, yeniden eskiye; retse sebepleri) ve son 50 iş. Kartı API'de barındırılmayan agent'ın kartı DID çözümüyle kendi adresinden okunur. API agent'ı henüz indexlemediyse sayfa DID'in zincirden çözümüne bağlantı verir |
| Bağlantılar | İş detayındaki agent satırı ve kayıt sayfasındaki "zaten kayıtlı" bilgisi profile gider |

## İş açma ve fonlama (FE-06)

Institution rolündeki cüzdan için; yalnızca `SQUARE_PROGRAM_ID_ESCROW` gerekir. Registry, policy ve verifier
programlarının kimlikleri, challenge süresi sınırları ve settlement mint'i escrow'un `EscrowConfig`
hesabından okunur (program arayüzü §4). Tx'ler SDK'nın akışıyla (`flow.createJob`, `flow.fundJob`) kurulur.

| Parça | Davranış |
|---|---|
| Agent | did:aip v2 Solana DID'i ya da `AgentRecord` adresi. DID bu ağın ve escrow'un okuduğu registry'nin olmalı; kayıt zincirden okunur, yalnızca etkin agent iş alır. Ödeme kaydın `wallet`'ına |
| Şartlar | Tutar USDC olarak (mint'in ondalığıyla), deadline yerel saatle, challenge süresi dakika olarak config'in sınırlarında. Politika, bu tarayıcıda commit edilmiş etkin politikalardan seçilir (FE-04); bağlanırsa release ispata bağlanır. Tutar politikanın public tavanını aşarsa iş açılmaz: escrow `AmountAboveDailyCeiling` döner, sayfa sebebini yazar ve düğmeyi kapatır ([ADR 0028](../../docs/decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)). Politikalı işte kurum, fonlamadan sonra iş sayfasında kabul öncesi ön-ispatı bağlar |
| İş tanımı | JSON nesnesi; A2A ile agent'a gider, zincire yalnızca RFC 8785 kanonik biçiminin SHA-256'sı (`spec_hash`). Job adresi kurum + hash'ten türer; aynı tanımla açılmış iş varsa durumu gösterilir ve fonlanabilir |
| Screening | Kurumun ve agent cüzdanının `ScreeningRecord`'u, escrow'un kuralıyla (`square_common::screening`): kayıt yok, işaretli, süresi dolmuş. Biri temiz değilse fonlama kapanır ve hangi cüzdanın neden kapattığı yazılır; program yine reddederse `ScreeningRequired` / `ScreeningExpired` / `ScreeningFlagged` aynı açıklamayla gösterilir, iş açık kalır |
| Fonlama | Kurumun USDC bakiyesi yetmiyorsa fonlama kapanır. Tutar Travel Rule eşiğinde ya da üstündeyse zincirdeki commitment bu tarayıcıdaki kayıtla eşleşene kadar kapalıdır (FE-18, aşağıda) |
| Tx | Kurum cüzdanının imzasıyla: `create_job` (iş ve vault), eşik üstünde `commit_travel_rule`, `fund_job` (tutar vault'a). Escrow hata kodu IDL'deki mesajıyla. Hesaplar ağ doğrulanmadan okunmaz |

## İş detayı (FE-07)

Herkese açık; eylemler bağlı cüzdana göre açılır. Yalnızca `SQUARE_PROGRAM_ID_ESCROW` gerekir.

| Parça | Davranış |
|---|---|
| Job | Escrow `Job` hesabı: durum, tutar, kurum, agent (DID çözümüne bağlantı), ödeme cüzdanı (alacak satıldıysa alıcı, değilse agent cüzdanı; iade edilen ya da iptal edilen işte kurum), deadline, challenge süresi, politika ve sürümü, `spec_hash`, teslimde URI ve `work_hash` |
| Zaman çizelgesi | Job hesabına ve alacak listelemesine (`["claim", job]`) dokunan son 50 işlemin loglarındaki escrow event'leri (`JobCreated` … `Finalized`, alacak ve uyuşmazlık event'leri), eskiden yeniye; yalnızca bu job'un ve escrow programının event'leri. Listelemenin geri çekilmesi (`cancel_claim`) yalnızca listelemeye dokunduğu için iki adres de izlenir. İki adresten birini anan her onaylı işlemde job, listeleme ve zaman çizelgesi yeniden okunur: log aboneliği (`onLogs`, WebSocket) anında bildirir; abonelik kurulamaz ya da koparsa iki adresin en yeni imzası 5 saniyede bir yoklanır (sekme görünürken). Aynı işlem ikisinden de gelirse bir kez okunur |
| Challenge sayacı | `challenge_end` zincir saatine göre: Clock sysvar'ının `unix_timestamp`'i okunur (dakikada bir yeniden), aradaki saniyeler yerel saatle ilerler. Escrow'un kuralıyla `challenge_end`'te kapanır |
| Agent | Bağlı cüzdan job'un `agent_wallet`'ıysa: fonlanmış işte `accept_job` (politikalı işte kurumun ön-ispatı bağlanana kadar düğme kapalı, sebebi yazılı); kabul edilmiş işte teslim dosyası tarayıcıda hash'lenir (SHA-256, SDK `workHash`), teslim URI'si en fazla 128 bayt, deadline'dan önce `submit_work`. Escrow hata kodu IDL'deki mesajıyla |
| Teslim dosyası | `SQUARE_API_URL` tanımlıysa dosya cüzdan oturumuyla API'ye yüklenir (`uploadDelivery`): depo içeriği SHA-256'sıyla adresler, makbuzun `deliveryUri`'si teslim URI'si olur. Makbuzun `workHash`'i tarayıcıdaki hash'ten farklıysa URI kullanılmaz; zincire tarayıcıdaki hash yazılır. API job'u henüz indexlemediyse (`not_found`) ya da cüzdan job'un agent'ı değilse (`forbidden`) sebebi yazılır. Dosya değişince önceki makbuzun URI'si temizlenir. URI elle de girilebilir (dosya başka yerde barındırılıyorsa); API tanımlı değilse yalnızca elle |
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

## Kabul öncesi ön-ispat (P-01)

Politikalı işte (fiat dahil) escrow, agent'ın kabulünden önce kurumun ön-ispatını ister (`PreflightProof`,
[ADR 0028](../../docs/decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)). İş `Open` ya da `Funded`'ken iş sayfasının "Pre-acceptance proof" bölümü:

| Parça | Davranış |
|---|---|
| Durum | Herkese açık: ön-ispat bağlı mı (`Bound` / `Missing`), anı (zincir saati) ve kalan geçici ret sebepleri. Bağlı değilse agent'ın "Accept the job" düğmesi kapalıdır ve sebebi yazılır. Ön-ispat başka bir agent cüzdanı için bağlanmışsa (iş sonra `sync_agent_wallet` ile taşındı) sayfa iki cüzdanı da gösterir (`Bound for another wallet`), kabul kapalı kalır ve kurum yeniden bağlar |
| Üretme | Bağlı cüzdan işi açan kurumsa. Politika, sır ve prover FE-09'daki gibidir. Witness işin kendi koşullarıyla, zincir saatinde kurulur (`buildPreflightWitness`: net işin tutarı, payee agent cüzdanı, sayaç 0). Kalıcı bir kural ya da günlük tavan çiğneniyorsa sayfa sebepleri yazar ve bağlamayı açmaz; iş kabul edilemez, iptal edilmelidir |
| Bağlama | `set_preflight_proof` (`buildSetPreflightProofTx`); ispatın anı bağlamada zincir saatine en fazla 600 s uzak olmalı, sayfa 540 s içinde bağlatır. Smart account'lu kurumda vault işlemidir (FE-21); sonradan multisig bağlamış kurumda sayfa bunu söyler. Verifier hata kodu IDL mesajıyla (`PreflightRefused`) |
| Zaman çizelgesi | `PreflightProofSet` (API'den): bağlandı, kalan geçici sebepler |

## Uyum ispatı ve release durumu (FE-09)

Politikaya bağlı işte escrow, kurumun bağladığı release ispatına (`ReleaseProof`, square_verifier) göre öder, iade eder ya da bekler ([ADR 0012](../../docs/decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md), [ADR 0013](../../docs/decisions/0013-release-keeper-ucreti-iade-ve-itibar.md)). İş sayfasının "Compliance proof" bölümü:

| Parça | Davranış |
|---|---|
| Durum | Herkese açık. İspat yoksa finalize bekler (`ProofRequired`). Varsa: karar, ret sebepleri (ret kodunun bitleri, [release-circuit.md](../../docs/design/release-circuit.md) §3), ispatın anı, payee, net ve günlük sayaç; escrow'un şimdi finalize'da ne yapacağı: ödeme, kesin retle kuruma iade (bit 0, 2, 3; sayaç 0 iken bit 1, 6) ya da bekleme |
| Tazelik | Zincir saatine göre, escrow'un `check_fresh`'iyle aynı kural (`checkFresh`, `@squaresdk/solana-policy`; Rust'la ortak vektörlerle denetlenir): payee (alacak satıldıysa alıcı), net (`amount − keeper ücreti`) ve mint release'inkiyle aynı, release ispatın UTC gününde ve kurumun sayacının etkin değeri ispattakiyle aynı. Bayatsa sebepleri (`StaleReleaseProof`); tazeyse geçerli olduğu son an (UTC gününün sonu) |
| İspat üretme | Bağlı cüzdan işi fonlayan kurumsa ve iş `Delivered` / `Disputed`'sa. Politika ve sır FE-04'ün bu tarayıcıdaki çalışma alanından okunur; job'un snapshot'ıyla (commitment, public tavan) aynı olmalı. Witness zincir saatiyle kurulur (`buildReleaseWitness`), ispatı prover servisi üretir (`createRemoteProver`, `x-api-key`; anahtar yalnızca sayfada tutulur). Beklenen artefakt sürümü devrenin manifest'indeki zkey SHA-256'sı. Prover'ı işleten politikayı görür; sayfa bunu söyler. snarkjs (GPL-3.0) yalnızca `apps/prover`'da çalışır |
| Bağlama | Kurum ispatın kararını (uyumlu ya da ret sebepleri, kesin mi geçici mi) görüp `set_compliance_proof`'la bağlar. İspatın anı bağlamada zincir saatine en fazla 600 s uzak olmalı; sayfa kalan süreyi gösterir, süre geçince yenisini ister. Squads vault'a bağlı kurumda bağlama vault işlemidir, sayfa bunu söyler. Verifier hata kodu IDL mesajıyla |
| Zaman çizelgesi | `ReleaseVerified` (payee ve net), `ReleaseRefused` (iade ve sebepleri) |

## Finalize, ödeme ve itibar (FE-10)

İş sayfasının "Payment" bölümü. Teslim edilmiş işte herkes finalize'ı tetikleyebilir, keeper ücreti tetikleyene gider ([ADR 0013](../../docs/decisions/0013-release-keeper-ucreti-iade-ve-itibar.md)).

| Parça | Davranış |
|---|---|
| Finalize | Zincir saatine göre: challenge penceresi kapanmadan, politikalı işte ispat yokken, geçici retteyken ya da ispat bayatken düğme kapalıdır ve sebebi (`ProofRequired`, `StaleReleaseProof`) yazılır. Ödeme dalında payee'nin (alacak satıldıysa alıcının) screening kaydı temiz ve taze değilse de kapalıdır (`ScreeningRequired`, `ScreeningFlagged`, `ScreeningExpired`); kesin retle iadede screening aranmaz. Kayıt dakikada bir yeniden okunur, süresi zincir saatine göre değerlendirilir. Hazırken ne olacağı önceden söylenir: payee'ye ödeme ya da kesin retle kuruma iade, neti ve keeper ücreti (`keeper_fee_bps`). Ücret tetikleyenin USDC hesabına gider; hesap yoksa önce açılır (tek tx, idempotent ATA). `flow.finalizePayment`; escrow hata kodu IDL mesajıyla ve ne yapılacağıyla |
| Settlement | Ödenmiş ya da iade edilmiş işte: payee'ye ödenen net (`ReleaseVerified`) ya da kuruma iade ve sebebi (`ReleaseRefused`), finalize eden ve ücreti (`Finalized`), validation kaydı (`ValidationRecord`: Verified / Refused / NoGate / NoPayout), payee'nin ve kurumun güncel USDC bakiyesi (hesap değişikliğiyle canlı). Event satırları işlem geçmişinden gelir; RPC geçmişi tutmuyorsa sayfa bunu söyler, sonuç validation kaydındadır |
| İtibar | Agent'ın `AgentReputation` hesabı: tamamlanan, başarısız ve uyuşmazlıklı işler, toplam kazanç, son settlement. İspatla reddedilen release sayılmaz (ADR 0013); sayfa bunu yazar |
| Keeper günlüğü | `listKeeperActions` (API, `SQUARE_API_URL`): job için keeper'ın (`apps/keeper`) denemeleri, sonucu, bekleme sebebi, ücreti, imzası ve sonraki denemesi; son 20. Keeper'ın bekletme ve onay kayıtları zincirde işlem üretmediği için iş teslim edilmişken ya da son deneme onay beklerken 15 saniyede bir yeniden okunur (sekme görünürken) |

## Kartla ödeme: fiat rayı (FE-20)

Fiat işte vault, fonlama, challenge penceresi, dispute, Travel Rule commitment'ı ve alacak satışı yoktur
([ADR 0024](../../docs/decisions/0024-stripe-mpp-fiat-rayi.md)). Kurum teslim edilen işin tutarını USD olarak
Square'in Stripe hesabına öder; MPP authority makbuzu işe ve tutara bağlayarak imzalar; kurumun uyum ispatı bu
attestation'la `verify_mpp_payment_proof`'a bağlanır; `finalize_fiat_payment` işi `Released` yapar
([ADR 0026](../../docs/decisions/0026-stripe-mpp-fiat-odemesi.md)). Ödeme alınıp ispat bağlanamazsa para iade
edilemez; arayüz ödemeyi buna göre açar.

| Parça | Davranış |
|---|---|
| Açılış | İş açma sayfasında "Card in USD (Stripe)": `flow.createFiatJob`. Politika zorunludur; challenge süresi ve fonlama yoktur. Tutar tam sent olmalı ve Stripe'ın en düşük tutarından (`getFiatConfig().minimumAmountMinor`) az olmamalı: 1 sent = 10^(decimals − 2) taban birim. İki tarafın screening'i açılışta denetlenir; biri temiz değilse açılış kapanır. Square API'sinin fiat rayı yapılandırılmamışsa seçenek kapalıdır ve sebebi yazılır |
| Kabul ve teslim | Fiat iş de politikalıdır: kurum iş `Open` iken kabul öncesi ön-ispatı bağlar (P-01, [ADR 0028](../../docs/decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md)); agent fiat işi açıkken, ön-ispat bağlıysa kabul eder. Teslim escrow işindeki gibidir |
| Ön denetim | Kurum ödemeden önce politikayı prover'da denetler: witness zincir saatiyle, makbuz sinyali sıfırdan farklı bir değerle kurulur (devrenin 12. sinyali ret koduna girmez). Ret varsa sebepleri yazılır ve ödeme kapalı kalır. Denetim aynı UTC gününde ve 540 s içinde geçerlidir; kalan süre yazılır |
| Ödeme | Kart alanı Stripe'ın çerçevesidir (`@stripe/stripe-js`, Card Element): kart bilgisi yalnızca Stripe'a gider. `createFiatPayment` (`offSession: false`) PaymentIntent'i açar ya da işin açık PaymentIntent'ini döner, `confirmCardPayment` onaylar (3D Secure dahil), ardından `reconcileFiatPayment` attestation'ı yazar. Kayıtlı kartla `offSession: true`; banka onay isterse (`requires_action`) aynı PaymentIntent Stripe'ın penceresiyle onaylanır. Ret sebepleri zarfın ayrıntılarından (`declineCode`, günlük tavanda `dailyCeiling`) yazılır. Stripe ödemeyi işliyorsa (`processing`) mutabakat yeniden sorulur |
| Makbuz | `getFiatAttestation` (yalnızca kurumun yetkilisine): ödenen tutar ve anı, PaymentIntent, makbuz commitment'ı, imzalayan MPP authority ve kaynağı (webhook, mutabakat, MPP) |
| İspat bağlama | "Prove and bind": witness makbuz commitment'ıyla kurulur, ispat üretilir ve `buildVerifyMppPaymentProofTx` ile (attestation imzası Ed25519 precompile'ında) tek adımda bağlanır. Uyumlu olmayan ispat bağlanmaz; ret sebebi ve geçici mi kalıcı mı olduğu yazılır. İspat bayatlarsa sebepleriyle yeniden bağlama istenir |
| Finalize | Herkese açık, cüzdanla (sponsorlu olabilir): `flow.finalizeFiatPayment`. Tetikleyen itibar ve validation kaydının rent'ini öder; keeper ücreti yoktur. Keeper fiat işleri finalize etmez |
| Kayıtlı kart | Hesap sayfası, kurum rolünde: `createFiatSetupIntent` ve `confirmCardSetup`. Square kartı Stripe'ın `setup_intent.succeeded` webhook'uyla kaydeder; sayfa kaydı birkaç kez okur, gelmediyse bunu söyler. Kart kurum anahtarı başınadır (cüzdan ya da smart account vault'u) |
| Paneller | Kurum panelinde fiat işler kasada sayılmaz; "Paid by card" release edilmiş fiat işlerin USD toplamı. Agent panelinde bekleyen fiat işler release bekleyen USDC'ye girmez; release edilmiş fiat işler itibarın `total_earned`'ündedir, ama ödeme agent cüzdanına değil Square'e yapılmıştır |
| Zaman çizelgesi | `FiatJobCreated`, `MppPaymentVerified` (API'den), fiat işte `Finalized` "Released" olarak |

- **Ödemenin açılmadığı durumlar:** Prover (`SQUARE_PROVER_URL`) yoksa, işin politikası bu tarayıcıda yoksa ya da
  kurumun yetkilisi sonradan bağlanmış bir Squads vault'uysa ispat bu sayfadan bağlanamaz. Bu durumda ödeme
  düğmeleri gösterilmez, sebep yazılır.
- **Smart account:** İspat bağlama tx'indeki Ed25519 precompile vault mesajına girmez; yürütme tx'inde yürütmenin
  hemen önüne konur (`sendInstructionsAsVault`). Bu yüzden adım yalnızca tek başına yürütebilen üyeyle (eşik 1,
  zaman kilidi yok) gönderilebilir; öneri açılmadan reddedilir.
- **Bu sürümde yok:** Agent'a USD ödemesi (Stripe Connect, ADR 0026 madde 1). MPP 402 yolu (`payFiatJobMpp`)
  `fiat:pay` kapsamlı API anahtarıyla ödeme ajanları içindir; arayüzde yoktur.
- **Uçtan uca:** [`apps/api/test/web-fiat.e2e.test.ts`](../api/test/web-fiat.e2e.test.ts), localnet ve gerçek
  tarayıcı. Stripe test modu anahtarlarıyla (`SQUARE_FIAT_E2E_STRIPE_SECRET_KEY`,
  `SQUARE_FIAT_E2E_STRIPE_PUBLISHABLE_KEY`) kart alanından ve kayıtlı kartla öder. Anahtarsız koşuda API testlerinin
  fixture Stripe'ıyla yalnızca kayıtlı kart yolunu dener. Her işte kurum kabulden önce ön-ispatı arayüzden bağlar.
  `SQUARE_SQUADS_CLONE_URL` verilirse aynı akışı smart account'lu kurumla da koşar; ön-ispat da vault tx'idir.

## Denetim görünümü (FE-12)

`/audit/[job]`, herkese açık; iş detayındaki zaman çizelgesinden "Audit trail" ile açılır. Uygulama gezinmesi yoktur: bağlantıyı alan biri (denetçi, karşı taraf) cüzdan bağlamadan okur. Yalnızca `SQUARE_PROGRAM_ID_ESCROW` gerekir; ağ doğrulanmadan hiçbir şey okunmaz.

| Parça | Davranış |
|---|---|
| Job | Zincirden: durum, tutar, kurum, agent (profile bağlantı), açılış ve settlement zamanı; politika adresi, sürümü ve commitment'ı (hash). Politikanın kuralları zincirde yoktur, sayfada da yoktur: tarayıcıdaki politika taslağı (FE-04) okunmaz |
| İspat kararı | Politikasız işte "no proof gate". Politikalı işte zincirdeki `ReleaseProof`: karar (uyumlu ya da ret ve ret kodunun sebepleri), ispat zamanı, payee, net, release'in kullanıp kullanmadığı; settlement'ta validation kaydı (`ValidationRecord`). Job'a bağlanan bütün ispatlar (verifier `ComplianceProofSet`), kararlarıyla ve işlemleriyle |
| Event'ler | `SQUARE_API_URL` tanımlıysa indexer'dan (`listEvents({ job })`, eskiden yeniye, en fazla 1.000): escrow event'leri ve verifier'ın ispat bağlama ve release kayıtları, tam geçmiş. Tanımlı değilse RPC'nin job'a dokunan son 50 işlemindeki escrow event'leri; sayfa bunu söyler. Her event'in zamanı, slot'u, imzası ve Solana Explorer bağlantısı (localnet'te uygulamanın RPC'siyle) |

## Paneller (FE-11)

`/app`'te rol seçiminin altında, seçilen rolün paneli; rol seçilmemişse ya da cüzdan bağlı değilse panel yoktur. Panel yalnızca seçildiğinde yüklenir (Anchor'a bağlı). `SQUARE_API_URL` ve `SQUARE_PROGRAM_ID_ESCROW` gerekir; ağ doğrulanmadan ne zincir ne API okunur. Listeler indexer'dan (API), en fazla 1.000 kayıt; fazlası varsa panel kaçının okunduğunu söyler. "Refresh" yeniden okur.

| Panel | İçerik |
|---|---|
| Kurum | Kurum hesabı (`Institution`, zincirden): ad, politika sayısı, varsa Squads vault'u. İşler (`listJobs({ institution })`; vault varsa onun açtıkları da): kasada kilitli tutar, ödenen, fonlanmamış, iade edilen ya da iptal edilen; durum süzgeçli liste. Günlük tavan: verifier'ın kurum sayacı (`OperatorState`, zincirden) zincir saatinin UTC gününe göre (`dailySpentAt`, ADR 0012), her etkin politikanın herkese açık tavanına (`daily_ceiling`) karşı; kalan ve sıfırlanma anı. Politikalar (`listPolicies`): API'deki adı, sürüm, durum, tavan, commitment |
| Agent | Cüzdanın sahibi olduğu agent kayıtları (`listAgents({ owner })`); başka ağın ya da escrow'un registry'si dışındaki kayıtlar gösterilmez, sayısı yazılır. Kazanç: ödenen (itibarın `total_earned`'i; satılmış alacakların neti dahil, onu alıcı aldı, ADR 0013), satılan alacakların fiyatı (satışta agent cüzdanına geçti), release'i bekleyen satılmamış işlerin bugünkü keeper ücretiyle neti. İtibar: tamamlanan, başarısız, uyuşmazlıklı, ilk ve son settlement. İşler, alacağın durumuyla |
| Alıcı | Cüzdanın aldığı alacaklar (`listClaims({ buyer })`): release'i bekleyenlerin bugünkü keeper ücretiyle neti, ödenenler, temerrüde düşenler (iş kuruma iade edildi); fiyat, yüz değer, iskonto, alım zamanı |

## Ağ sayfası (FE-11)

`/app/network`, cüzdan gerekmez. Hepsi zincirden okunur, ağ doğrulanmadan okunmaz; indexer gerekmez.

| Parça | Davranış |
|---|---|
| Programlar | Her program için BPF upgradeable loader'ın hesapları: upgrade authority (yoksa ya da sıfır adresse "Immutable"), son deploy'un slot'u, program data adresi; deploy edilmemiş, program olmayan ya da başka loader'ın programı olan hesap sebebiyle |
| Config'ler | `RegistryConfig`, `VerifierConfig`, `EscrowConfig`: alanlar JSON IDL'den (program sözleşmesi, BC-44) adı, sırası ve açıklamasıyla, sözleşmedeki gibi snake_case. `*_bps` yüzdeyle, `*_secs` ve `*_period` süreyle, tutarlar USDC ve taban birimiyle; `arbitrators`'ın yalnızca etkin yuvaları (`arbitrator_count`). Program alanları (`*_program`) yapılandırmadaki program kimlikleriyle karşılaştırılır; upgrade authority olan adresler belirtilir. square_policy'nin config'i yoktur |
| Keeper ücreti | `EscrowParams.keeper_fee_bps` ve sözleşmedeki açıklaması |
| ALT | `SQUARE_LOOKUP_TABLE`: authority (dondurulmuş mu), etkin mi, son genişletme slot'u, girdiler. Program kimliklerinin dördü de tanımlıysa içerik SDK'nın beklediği adreslerle (`squareLookupTableAddresses`, escrow config'inin settlement mint'iyle) karşılaştırılır; her girdinin ne olduğu yazılır, eksik ve fazla adresler listelenir |
| Square API | `SQUARE_API_URL` tanımlıysa `/ready`: durum, sürüm ve bağımlılıkların (veritabanı, RPC, depo) denetimi |

## Travel Rule (FE-18)

Eşiği aşan işte kurum, fonlamadan önce Travel Rule kaydının salt'lı commitment'ını işe bağlar ([ADR 0015](../../docs/decisions/0015-travel-rule-commitment-ve-esik.md)). Eşik escrow config'indeki `travel_rule_threshold`'dur (0 = kapalı; `amount >= eşik` ise gerekir). Kayıt Square API'sinde şifreli saklanır (BE-23, [ADR 0017](../../docs/decisions/0017-travel-rule-saklama-erisim-ve-paylasim.md)); zincirde yalnızca 32 baytlık commitment vardır. `SQUARE_API_URL` tanımlı değilse kayıt saklanamaz ve eşik üstündeki iş bu sayfadan fonlanamaz.

| Parça | Davranış |
|---|---|
| Form | Originator (kurum) ve beneficiary (agent'ın işletmecisi), `@squaresdk/solana-types`'ın `TravelRuleRecord` biçiminde (IVMS101 alt kümesi): kişi türü (tüzel / gerçek), ad (tüzelde unvan, gerçekte soyad ve adlar), adres (sokak, şehir, posta kodu, ISO 3166-1 alfa-2 ülke), ulusal kimlik (IVMS101 kimlik türü, değeri, veren ülke; LEI'de ülke yok, ISO 17442 kontrol haneleri denetlenir), gerçek kişide doğum tarihi ve yeri, ikamet ülkesi; isteğe bağlı originating ve beneficiary VASP (ad, LEI). Originator adres, ulusal kimlik ya da doğum tarihi ve yerinden birini verir (FATF Tavsiye 16). Hesaplar girilmez: kurum cüzdanı ve işin agent cüzdanı; tutar ve mint işinkidir. Kayıt API'ye gitmeden ortak şemadan geçer (`src/lib/travel-rule.ts`) |
| Saklama ve bağlama | İş `Open`'ken, sihirbazda ya da iş sayfasında, Square API oturumuyla (FE-03): `PUT /v1/jobs/{job}/travel-rule` kaydı şifreler, yeni bir salt üretir ve commitment'ı döner; ardından `commit_travel_rule` (SDK `flow.commitTravelRule`) yalnızca o commitment'ı zincire yazar. Fonlamaya kadar yeni kayıtla değiştirilebilir, son bağlanan geçerlidir |
| Doğrulama | "Check against the stored record": `GET /v1/jobs/{job}/travel-rule` kaydı ve salt'ı açar (okuma API'nin erişim kaydına yazılır), commitment bu tarayıcıda SDK'nın `travelRule.commitment`'ıyla yeniden hesaplanıp zincirdekiyle karşılaştırılır: API'nin sözüne güvenilmez. Saklama zamanı ve saklama süresinin sonu gösterilir. Commitment'ın zincirdeki uygulamayla aynılığı ortak vektörlerle (`crates/square-common/tests/fixtures/travel-rule-vectors.json`) test edilir |
| Fonlama kapısı | Eşik üstünde fonlama, zincirdeki commitment API'de saklanan kaydın salt'ı ve içeriğinden yeniden hesaplanan commitment'a eşit olana kadar kapalıdır: bu oturumda saklanıp bağlanan kayıt kendiliğinden, sonrası doğrulamayla. Commitment yoksa, API'de kayıt yoksa ya da eşleşmiyorsa sebebi yazılır. Program yine reddederse `TravelRuleCommitmentRequired` ne yapılacağıyla gösterilir |
| Durum (iş sayfası) | Herkese açık: "Not required", "Waiting for the commitment" (eşik üstü, `Open`), "Commitment bound" (commitment hex), "No commitment" (eşik sonradan yükseldi). Zaman çizelgesinde `TravelRuleCommitted` |

Karşı VASP'a ya da denetçiye erişim izni (`createTravelRuleGrant`) ve erişim kaydı API'de (BE-23) vardır; bu sayfada henüz yok.

## Uyuşmazlık (FE-17)

M-of-N arbitration ve dispute zaman aşımının arayüzü ([ADR 0016](../../docs/decisions/0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md)). Kurallar programındır; arayüz aynılarını düğmeleri açmak ve açıklamak için uygular (`src/lib/dispute.ts`, testli). Süreler zincir saatine göredir (Clock sysvar'ı, `useChainClock`). Arbitrator seti, eşik, bond kuralı ve süreler her değişiklikte escrow config'inden yeniden okunur.

| Parça | Davranış |
|---|---|
| Durum (iş sayfası) | Herkese açık: challenger (kurum ya da ispatsız bekleme başvurusundaki agent), bond, `reason_hash`, açılış, son tarih ve geri sayım, oy sayısı / eşik (M), bekleyen karar. Dispute'un set sürümü config'tekinden eskiyse eski oylar sayılmaz ve bunu söyler. Durum rozetleri: açık, son tarih geçti, karara bağlandı, lapse, kapandı |
| İtiraz (kurum) | İş `Delivered`, işte ilk dispute ve challenge penceresi açıkken (kalan süre gösterilir). Minimum bond `max(amount × min_bond_bps / 10 000, min_bond_absolute)` (en az 1) config'ten hesaplanıp önerilir, altı ve USDC bakiyesini aşanı reddedilir. Kanıt dosyası tarayıcıda SHA-256'lanır; API tanımlıysa `POST /v1/jobs/{job}/dispute/evidence` ile özel depoya yüklenir ve dönen `reasonHash` yerel hash'le aynı olmalıdır. Sonra `raise_dispute` (SDK `flow.raiseDispute`, bond kurumun USDC hesabından bond vault'una) |
| Başvuru (agent) | Policy'li ve `Delivered` işte `challenge_end + proof_timeout_secs`'ten (önceki dispute lapse olduysa kapanışından) sonra; geri sayım gösterilir. Bugün işi kapatan bir ispat bağlıysa (uyumlu ya da kesin ret, aynı UTC günü) finalize'a yönlendirir. `escalate_missing_proof` bond'suzdur |
| Kararın ödenmesi | `Resolved` işte herkes `execute_resolution` gönderir; agent tarafına, kuruma ve bond'a ne gideceği önceden gösterilir. Policy'li işte agent tarafı tutarı ispat kapısından geçer: taze uyumlu ispat yoksa ödeme `ProofRequired` ile bekler, sayfa bunu söyler |
| Lapse | Son tarihte ve sonrasında karara bağlanmamış dispute için uyarı ve herkese `lapse_dispute` (keeper'ın lapse crank'i de yapar). Lapse sonrası iş `Delivered`'a döner; bölüm "bond iade edildi" bilgisini (bond'suz başvuruda iade yok) ve kapanış anını gösterir |
| Kanıtlar | Taraflara (kurum, agent cüzdanı, aktif arbitrator'lar) API oturumuyla: liste (`isDisputeReason` işaretli), indirme (ek olarak, sayfada açılmaz), dispute açıkken ve karara bağlıyken kanıt ekleme. Yetkiyi API denetler |
| Arbitrator konsolu | `/app/arbitration`: cüzdan zincirdeki aktif sette değilse açılmaz. Kuyruk `GET /v1/arbitration/queue`'dan 50'şerli sayfalarla, her dispute'un job'u zincirden okunur. Kart: tutar, challenger, bond, son tarih ve geri sayım, oylar (onay ve ret), oy sayısı / eşik, ret sayısı, bekleyen öneri, kanıtlar. Oy: lehine agent, lehine kurum ya da split (agent payı USDC, en fazla escrow tutarı). Bekleyen öneri varsa aynı karar onay, farklı karar ret oyudur (ADR 0028); düğme hangisi olduğunu söyler. Son tarih geçtiyse, bekleyen öneriye oy verildiyse (zincir ya da API'nin `hasVoted`'ı) oy kapalıdır |
| Oy tx'i | `POST /v1/disputes/{job}/votes` imzasız v0 tx döndürür. Tx imzadan önce çözülür (ALT'ler zincirden): fee payer ve tek imzacı arbitrator, talimatlar tek bir escrow `resolve_dispute` ile en çok birer compute unit sınırı (en çok 1 400 000) ve fiyatı (en çok 1 000 000 micro-lamport/CU), hesaplar `[arbitrator, config, job]`, karar seçilenle aynı. Değilse imzalatılmaz |
| Bildirim | Konsolda webhook abonelikleri: liste, ekleme (https; localnet'te http, olay seçimi) ve silme. İmza sırrı (`whsec_…`) yalnızca ekleme yanıtında bir kez gösterilir |
| Hatalar | Escrow hata kodları IDL mesajı ve ne yapılacağıyla: `InsufficientBond`, `DisputeWindowClosed`, `DisputeAlreadyRaised`, `DisputeAlreadyActive`, `NoActiveDispute`, `NotArbitrator`, `AlreadyVoted`, `ResolutionMismatch`, `ResolutionNotDecided`, `InvalidSplitAmount`, `DisputeNotExpired`, `ProofTimeoutNotReached`, `InvalidDisputeTimeout`, `ProofRequired`, `StaleReleaseProof`, screening kodları. API'nin `simulation_failed` / `program_error` yanıtındaki program hatası da aynı açıklamayla gösterilir |
| Zaman çizelgesi | `DisputeRaised` (challenger, bond, son tarih), `DisputeVote` (arbitrator, oy, sayım), `DisputeDecided`, `DisputeResolved` (dağılım), `DisputeLapsed` (iade edilen bond, iş `Delivered`'a döndü), `MissingProofEscalated` |

Bileşenler sahte zincir hesaplarıyla, tx'ler SDK akışıyla kurulup çözülerek test edilir. Arayüzün dayandığı API ve programlar devnet'te uçtan uca denendi ([apps/api](../api/README.md#testler)). Arayüzden uçtan uca koşu `apps/api/test/web-dispute.e2e.test.ts`'tedir ([apps/api](../api/README.md#testler)):
derlenmiş web, localnet'te gerçek programlar, gerçek indexer ve API, Chrome. Her rolün tarayıcı bağlamına bir Wallet
Standard cüzdanı eklenir; imzalar rolün anahtarıyla atılır. Kurum itiraz eder, iki arbitrator konsoldan oy verir,
karar iş sayfasından ödenir; ikinci işte son tarih geçince sayfadan lapse edilir.

## Geliştirici portalı (FE-22)

Harici geliştiricinin self-servis sayfası (`/app/developers`); `SQUARE_API_URL` gerekir. Ücretli uç nokta
kararı: [ADR 0023](../../docs/decisions/0023-x402-ucretli-uc-nokta-tanimlari.md).

| Parça | Davranış |
|---|---|
| Oturum | Bağlı cüzdan `createAuthChallenge`'ın metnini imzalar (wallet-adapter `signMessage`; işlem değildir, ücretsizdir), imza base58 ile `createSession`'a gider. Belirteç yalnızca sayfanın belleğindedir: yenilemede, cüzdan değişince, süresi dolunca ya da API `unauthorized` dönünce oturum kapanır. Mesaj imzalayamayan cüzdan bunu söyler |
| API anahtarları | Liste: etiket, ön ek, kapsamlar, oluşturma ve son kullanım zamanı. Oluşturma etiket ve kapsamlarla; sır yalnızca oluşturma yanıtında gelir, bir kez gösterilir ve kopyalanır, kapatılınca sayfadan silinir. İptal hemen geçerlidir |
| Ücretli uç noktalar | Tanım: ad, yol (geliştiricinin sunucusundaki route), fiyat, mint, ağ, alıcı (`payTo`, varsayılan bağlı cüzdan), açıklama, etkin / pasif. Ağ uygulamanın kümesinden gelir (localnet'te devnet), mint ağın USDC'si; USDC'de fiyat USDC olarak girilir ve tam sayı aritmetiğiyle taban birime çevrilir, başka mint'te taban birimdir. Düzenleme, pasifleştirme ve silme. Kullanım: ödemeli çağrı sayısı, tahsil edilen toplam, son ödeme ve son ödemeler (ödeyen, tutar, işlem) |
| SDK örnekleri | Seçilen anahtar ve uç noktayla doldurulur, kopyalanır: `createApiClient` (anahtarın kapsamına göre), geliştiricinin sunucusu (`paidRouteFromDefinition` → `paidRoute`, kendi facilitator'ı, ödemenin bildirimi) ve ödeyen istemci (`createPayingFetch`). Sırlar ortam değişkenlerindedir. `test/developer-snippets.test.ts` her örneği doldurulmuş hâliyle gerçek paketlere karşı TypeScript derleyicisinden geçirir |

## Smart account ve sponsorlu işlem (FE-21)

`/app/account`. Rolün zincirdeki adresi ve işlemlerin ücretini kimin ödediği burada seçilir. Bileşenler
[`actor.tsx`](src/components/actor.tsx)'teki `useActor(rol)`'den rolün adresini, SDK seçeneklerini (`options()`:
ücret ve rent ödeyicisi), gönderimi (`send`) ve API isteklerinin seçeneğini (`api`) alır.

| Mod | Rol adresi | Ücret ve rent | Gönderim |
|---|---|---|---|
| Cüzdan (varsayılan) | Cüzdan | Cüzdan | FE-03'teki korumalı gönderim |
| Sponsorlu | Cüzdan | Sponsor | Cüzdan imzalar; `POST /v1/sponsor` (`submit: true`) denetleyip sponsorla imzalar ve gönderir |
| Smart account | Squads v4 multisig'inin 0 numaralı vault'u | Sponsor | Talimatlar vault tx'ine sarılır (SDK `wrapInVault`): öneri (vault tx, proposal, üyenin onayı) zincirde onaylanınca yürütme. İkisi de sponsorlu |

- **Seçimler:** Sponsorlu gönderim cüzdan başına (`localStorage.square-sponsored:<cüzdan>`), smart account cüzdan ve
  rol başına (`square-smart-account:<cüzdan>:<rol>`) bu tarayıcıda tutulur. Smart account kurum, agent ve alıcı için
  vardır. Arbitrator cüzdanıyla oy verir. Finalize, kararın yürütülmesi ve lapse gibi herkese açık adımlar cüzdanla
  (sponsorlu olabilir) gider.
- **Sponsor bilgisi:** Adres ve tavanlar servisin oturumlu `/v1/sponsor/info` ucundan okunur. Gerekirse önce API
  oturumu imzalatılır. Compute unit sınırı simülasyonla ölçülür, %20 pay eklenir ve sponsorun tavanını aşamaz. Ret
  sebebi (`error.details.reason`) arayüz metnine çevrilir ([`fee-payer.ts`](src/lib/fee-payer.ts)).
- **Smart account açma:** Sponsor `multisig_create_v2`'nin `creator`'ıdır; rent'i ve Squads'ın oluşturma ücretini o
  öder. `createKey` tarayıcıda üretilen tek kullanımlık anahtardır ve yalnızca açılışı imzalar; cüzdan imza atmaz.
  - Bağlı cüzdan her zaman üyedir. Diğer üyeler bütün yetkilerle (Initiate, Vote, Execute) eklenir.
  - Eşik en çok üye sayısıdır. Multisig özerktir; zaman kilidi yoktur.
- **Var olan smart account:** Adres zincirden okunur. Cüzdan `Initiate` yetkili üye değilse seçilemez.
- **Üyelik görünümü:**
  - Üyeler ve yetkileri; eşik ve zaman kilidi.
  - Vault (rolün adresi) ile SOL ve USDC bakiyesi. USDC vault'un adresine yatırılır.
  - Son on öneri: durum, onaylar, iç talimatların programları. Bayatlamış öneri (`stale_transaction_index`'e kadar)
    yürütülemez.
  - Oy veren üye onaylar, yürütme yetkili üye onaylanmış öneriyi zaman kilidinden sonra yürütür. İkisi de sponsorlu.
- **Eşik 1'den büyükse:** Adım öneriden sonra durur ve sayfa öneriyi söyler ("Proposed as smart account transaction
  #N"). Diğer üyeler hesap sayfasından onaylar, yürütme yetkili bir üye yürütür.
- **API:** Rol adına giden istekler `X-Square-Smart-Account: <multisig>` başlığını taşır
  ([apps/api](../api/README.md#kimlik), API sözleşmesi v0.24.0). Kapsananlar: teslimat yükleme, kart barındırma,
  Travel Rule ve dispute kanıtı. API cüzdanın multisig'te `Initiate` yetkili üye olduğunu zincirden okur.
- **Sayfalar:** Politika, agent kaydı, iş açma ve fonlama, iş detayı (kabul, teslim, ispat, alacak, uyuşmazlık) ve
  paneller rolün adresiyle çalışır. Sayfanın üstündeki not hangi adres adına gidildiğini ve ücretin kimde olduğunu
  söyler.
- **Sponsorlu finalize:** Sponsor yalnızca Square ya da Squads talimatı taşıyan tx'i öder
  (`no_square_instruction`). Bu yüzden keeper ücretinin USDC hesabı ayrı bir tx'le değil, finalize'la aynı tx'te
  açılır; rent'i sponsor öder.
- **Bilinen sınırlar:**
  - `finalize_payment`'ın açtığı itibar ve doğrulama kayıtlarının rent'ini program tetikleyene ödetir
    (`payer = keeper`). Sponsorlu finalize'da da cüzdanın bu rent kadar SOL'ü olmalı.
  - Multisig'i `set_institution_multisig` ile sonradan bağlanmış kurumun (kurum hesabı cüzdandan türemiş) adımları bu
    sayfadan önerilmez; bu kurumun ispat bölümü durumu söylemeye devam eder.
  - CCTP ile fonlama (FE-19) cüzdanla çalışır.
  - Fiat işin ispat bağlaması (FE-20) Ed25519 precompile taşır: yalnızca tek başına yürütebilen üyeyle gider.

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

**Arayüzden uçtan uca testler** `apps/api/test/` altındadır ve derlenmiş web'i gerçek bir tarayıcıda, localnet'teki
gerçek programlara karşı koşar ([apps/api](../api/README.md#testler)):
- `web-flow`: kendi cüzdanlarıyla 8 adım ve ret senaryosu (FE-13);
- `web-dispute`: uyuşmazlık (FE-17);
- `web-smart-account`: smart account'la sponsorlu 8 adım (FE-21).

CI'da `Web E2E` iş akışı üçünü her PR'da koşar ([docs/ci.md](../../docs/ci.md)).

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
| Variables | `SQUARE_SOLANA_CLUSTER`, `SQUARE_SOLANA_RPC_URL`; her environment (devnet `staging`, PR preview) için ayrı; mainnet ortamı yok ([ADR 0027](../../docs/decisions/0027-yalnizca-devnet.md)) |
| Networking | Public domain; port Railway'in verdiği `PORT` |
| PR Environments | Proje ayarlarında açık; izlenen yollar sayesinde yalnızca web'i etkileyen PR'lar için web deploy'u kurulur |

Yerelde imaj: `docker build -f apps/web/Dockerfile -t square-web .` (repo kökünden), ardından `docker run -p 3000:3000 -e SQUARE_SOLANA_CLUSTER=… -e SQUARE_SOLANA_RPC_URL=… square-web`.
