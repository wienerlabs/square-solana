# apps/web — `@squaresdk/solana-web`

Square'in web uygulaması: Next.js 16 (App Router), React 19, Tailwind CSS 4 ve `@solana/wallet-adapter-react` ([§12.4](../../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)). Bu sürüm iskelettir (FE-01): cüzdan bağlantısı, bağlı cüzdanın adresi ve bakiyesi, yapılandırılan ağın canlı durumu. Görsel kimlik FE-02'de, sayfalar M4'te gelir.

## Yapılandırma

Değerler ortamdan gelir ve kök layout'ta **istek anında, sunucuda** okunur (`connection()`), derlemeye gömülmez. Aynı derleme her ortamda kendi değerleriyle çalışır. Kodda varsayılan ağ ya da RPC adresi yoktur. Değişkenlerden biri eksik ya da geçersizse uygulama yerine hangi değişkenin neden reddedildiğini gösteren bir yapılandırma sayfası açılır.

| Değişken | Değer |
|---|---|
| `SQUARE_SOLANA_CLUSTER` | `devnet`, `testnet`, `mainnet-beta` ya da `localnet` |
| `SQUARE_SOLANA_RPC_URL` | O cluster'ın JSON-RPC ucu; `https` (yalnızca `localnet` için `http`). WebSocket ucu web3.js tarafından bundan türetilir |

RPC adresi istemci bileşenine (`ConnectionProvider`) gider, yani tarayıcıya iner: ekranda yalnızca host gösterilse de sayfa yükünde görünür. İçinde API anahtarı olan bir RPC kullanılacaksa ya alan adıyla kısıtlanmış (domain allowlist'li) bir anahtar ya da anahtarı sunucuda tutan bir vekil gerekir.

## Cüzdanlar

- Phantom ve Solflare adapter'ları açıkça kayıtlıdır: kurulu değillerse modal kurulum bağlantısını gösterir.
- Backpack ve diğer Wallet Standard cüzdanları kuruluysa otomatik algılanır. Backpack'in ayrı bir wallet-adapter paketi yoktur. Kurulu Phantom ve Solflare de Wallet Standard ile gelir ve aynı adlı adapter'ın yerini alır.
- `autoConnect` açık: son seçilen cüzdan (`localStorage.walletName`) sayfa açılınca yeniden bağlanır.

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
