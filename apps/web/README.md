# apps/web — `@squaresdk/solana-web`

Square'in web uygulaması: Next.js 16 (App Router), React 19, Tailwind CSS 4 ve `@solana/wallet-adapter-react` ([§12.4](../../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)). Şu an iskelet (FE-01), tasarım sistemi (FE-02) ve landing (FE-15) var. 8 adımın sayfaları M4'te gelir.

| Rota | İçerik |
|---|---|
| `/` | Landing: değer önerisi, 8 adımlı akış, programlar ve ağ (canlı); bütün butonlar uygulamaya gider |
| `/app` | Uygulama: bağlı cüzdanın adresi, SOL ve USDC bakiyesi, ağın canlı durumu ve doğrulaması, rol seçimi |
| `/app/policy` | Kurumun harcama politikası: sır, kural editörü, alıcı listesi, zincire gidecek değerler (FE-04) |
| `/design` | Bileşen kataloğu |
| `/healthz` | Sağlık kontrolü (Railway) |

## Yapılandırma

Değerler ortamdan gelir ve kök layout'ta **istek anında, sunucuda** okunur (`connection()`), derlemeye gömülmez. Aynı derleme her ortamda kendi değerleriyle çalışır. Kodda varsayılan ağ ya da RPC adresi yoktur. Değişkenlerden biri eksik ya da geçersizse uygulama yerine hangi değişkenin neden reddedildiğini gösteren bir yapılandırma sayfası açılır.

| Değişken | Değer |
|---|---|
| `SQUARE_SOLANA_CLUSTER` | `devnet`, `testnet`, `mainnet-beta` ya da `localnet` |
| `SQUARE_SOLANA_RPC_URL` | O cluster'ın JSON-RPC ucu; `https` (yalnızca `localnet` için `http`). WebSocket ucu web3.js tarafından bundan türetilir |
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
| Kurallar | `PolicyDocument`'ın alanları, devrenin sınırlarıyla (`POLICY_CIRCUIT_LIMITS`). Tutarlar settlement mint'inin taban biriminde; mint biliniyorsa USDC karşılığı ve whitelist'te olup olmadığı gösterilir. Public tavan 0 ya da whitelist'te settlement mint yoksa uyarı verilir |
| Alıcılar | Satır başına bir cüzdan; her alıcıya `generateLeafSalt()` ile salt, kök `buildBuyerTree` ile. Boş liste sıfır kök (kısıtsız) |
| Zincire giden | Institution ve Policy PDA'ları, `policy_id`, commitment (`computePolicyCommitment`), `daily_ceiling`, `buyer_root`; hepsi tarayıcıda hesaplanır. `set_policy` / `set_buyer_root` tx'leri, square_policy bu instruction'larla deploy edilince eklenecek (BC-17, BC-18) |

PDA'lar SDK'nın IDL seed'lerinden türetilir (`src/lib/idl-pda.ts`, SDK'nın `createPda`'sıyla aynı adresler; testli). Anchor yalnızca gerektiğinde yüklenir.

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
