# apps/web — `@squaresdk/solana-web`

Square'in web uygulaması: Next.js 16 (App Router), React 19, Tailwind CSS 4 ve `@solana/wallet-adapter-react` ([§12.4](../../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)). Şu an iskelet (FE-01) ve tasarım sistemi (FE-02) var: cüzdan bağlantısı, bağlı cüzdanın adresi ve bakiyesi, yapılandırılan ağın canlı durumu ve `/design`'daki bileşen kataloğu. 8 adımın sayfaları M4'te gelir.

## Yapılandırma

Değerler ortamdan gelir ve kök layout'ta **istek anında, sunucuda** okunur (`connection()`), derlemeye gömülmez. Aynı derleme her ortamda kendi değerleriyle çalışır. Kodda varsayılan ağ ya da RPC adresi yoktur. Değişkenlerden biri eksik ya da geçersizse uygulama yerine hangi değişkenin neden reddedildiğini gösteren bir yapılandırma sayfası açılır.

| Değişken | Değer |
|---|---|
| `SQUARE_SOLANA_CLUSTER` | `devnet`, `testnet`, `mainnet-beta` ya da `localnet` |
| `SQUARE_SOLANA_RPC_URL` | O cluster'ın JSON-RPC ucu; `https` (yalnızca `localnet` için `http`). WebSocket ucu web3.js tarafından bundan türetilir |

RPC adresi tarayıcıya gider; içinde API anahtarı varsa o anahtar herkese açıktır. Tarayıcı için kısıtlanmış (domain allowlist'li) bir anahtar kullanın. Ekranda yalnızca host gösterilir.

## Cüzdanlar

- Phantom ve Solflare adapter'ları açıkça kayıtlıdır: kurulu değillerse modal kurulum bağlantısını gösterir.
- Backpack ve diğer Wallet Standard cüzdanları kuruluysa otomatik algılanır. Backpack'in ayrı bir wallet-adapter paketi yoktur. Kurulu Phantom ve Solflare de Wallet Standard ile gelir ve aynı adlı adapter'ın yerini alır.
- `autoConnect` açık: son seçilen cüzdan (`localStorage.walletName`) sayfa açılınca yeniden bağlanır.

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
pnpm --filter @squaresdk/solana-web build      # üretim derlemesi (env gerekmez)
pnpm --filter @squaresdk/solana-web start      # derlenmiş uygulama
pnpm --filter @squaresdk/solana-web typecheck  # next typegen + tsc
pnpm --filter @squaresdk/solana-web test       # vitest
```

`dev` ve `start` için iki değişkeni ortamda verin ya da `apps/web/.env.local`'a yazın (`.env*` git'e girmez).

## Vercel

Proje ayarları (bir kez, Vercel panelinden):

| Ayar | Değer |
|---|---|
| Root Directory | `apps/web` |
| Framework Preset | Next.js (kurulum ve derleme komutları varsayılan; pnpm workspace'i kökten kurulur) |
| Node.js | 24.x |
| Environment Variables | `SQUARE_SOLANA_CLUSTER`, `SQUARE_SOLANA_RPC_URL` — Preview ve Production için ayrı ayrı |

GitHub entegrasyonu açıkken her PR için bir preview deploy oluşur. CI'da derleme `.github/workflows/packages.yml`'daki `pnpm turbo run build typecheck test` ile koşar.
