# @squaresdk/solana-mcp

İki yönlü MCP (BE-28):
- **Square MCP sunucusu:** Square'i MCP konuşan her agent'a açar: Claude Desktop, Claude Code, Cursor ya da otonom
  bir döngü.
- **Havuzlu MCP istemcisi:** Agent'ın başka MCP sunucularının araçlarını çağırması için.

Sunucu Covenant'ın `mcp/` sunucusundan uyarlandı (`docs/provenance/BE-02.md`): beş okuma aracının kapsamı korundu,
kaynak Covenant'ın HTTP API'si yerine Square programlarının zincirdeki hesaplarıdır. Yazma araçları eklendi.

## Araçlar

| Araç | Ne yapar | İmza |
|---|---|---|
| `square_find_work` | İşler: agent kaydına, kuruma, duruma (varsayılan `funded`, kabul bekleyen) ve USDC tutarına göre | Yok |
| `square_get_job` | Tek job: durum, tutar, taraflar, politika, süreler, teslim, dispute; alacak listelemesi | Yok |
| `square_settlement_stats` | Bütün job hesaplarından: durum sayıları, kasada kilitli ve ödenen USDC | Yok |
| `square_get_reputation` | Agent'ın itibarı (escrow `AgentReputation`); agent kaydıyla ya da sahibin bütün kayıtları | Yok |
| `square_discover_agents` | Agent kayıtları, itibara göre sıralı; `skill` ile agent card'ın becerilerinden (kartın zincirdeki hash'i doğrulanır) | Yok |
| `square_create_job` | Job açar: agent kaydına bağlar, spec'in hash'i, tutar, deadline, challenge penceresi, isteğe bağlı politika | Kurum |
| `square_fund_job` | Tutarı kurumun USDC hesabından job'un kasasına kilitler | Kurum |
| `square_accept_job` | Fonlanmış job'u kabul eder | Agent cüzdanı |
| `square_submit_work` | Teslim: işin SHA-256'sı ve URI'si zincire. İçerik verilirse Square API'ye yüklenir | Agent cüzdanı |
| `square_send_transaction` | İstemcide imzalanmış tx'i gönderir; eksik imzalı tx'i reddeder | Tx'teki imzalar |

**Okuma:** Okuma araçları cüzdan ve barındırılan bir API gerektirmez; RPC ve program kimlikleri yeter. Süzgeçler
RPC'nin `memcmp`'idir; alanların konumu IDL'den hesaplanır. İstatistik, job hesaplarının yalnızca mint, tutar ve durum
dilimini okur.

**Yazma, imza akışıyla:** Rol imzacısı (kurum ya da agent cüzdanı) zincirdeki job'dan okunur, araç argümanından
alınmaz.
- **`SQUARE_MCP_KEYPAIR` o rolün anahtarıysa:** Sunucu tx'i imzalar, gönderir ve onayı bekler.
- **Anahtar başka birinin ise:** Tx kurulmaz; sunucu kendi anahtarı dışında kimse adına imza atmaz.
- **Anahtar yoksa:** İmzasız tx döner (`signatureRequired`). Rol cüzdanı imzalar ve `square_send_transaction` ile
  ya da kendisi gönderir.

Hiçbir yazma aracı imzasız tx'i zincire göndermez. Ödemeyi (`finalize_payment`) araç değil keeper yapar: challenge
penceresi bitince izinsiz crank'tir (apps/keeper).

## Yapılandırma

Varsayılan değer yoktur; eksik ya da geçersiz değerde sunucu açılmaz.

| Değişken | |
|---|---|
| `SQUARE_MCP_CLUSTER` | `mainnet-beta`, `devnet`, `testnet` ya da `localnet` (Explorer bağlantıları) |
| `SQUARE_MCP_RPC_URL` | Solana RPC |
| `SQUARE_PROGRAM_ID_{REGISTRY,POLICY,VERIFIER,ESCROW}` | Programların o ağdaki adresleri (web ve db ile aynı adlar; devnet: [deploy kaydı](../../docs/deploy/devnet.md#servislerin-devnet-değerleri)) |
| `SQUARE_MCP_TIMEOUT_MS` | Agent card ve API istekleri için zaman aşımı |
| `SQUARE_MCP_CARD_MAX_BYTES` | İndirilen agent card'ın üst sınırı |
| `SQUARE_MCP_KEYPAIR` | İsteğe bağlı: imzacının keypair dosyası (solana-keygen biçimi). Log'a yalnızca açık anahtarı yazılır |
| `SQUARE_MCP_LOOKUP_TABLE` | İsteğe bağlı: Square ALT'ı (BC-28) |
| `SQUARE_MCP_COMPUTE_UNIT_PRICE` | İsteğe bağlı: priority fee (mikro-lamport / CU) |
| `SQUARE_API_URL`, `SQUARE_API_KEY` | İsteğe bağlı, birlikte: teslim içeriğinin yüklenmesi (`deliveries:write` kapsamlı anahtar) |

## Claude Desktop

`pnpm --filter @squaresdk/solana-mcp build`. Ardından Claude Desktop'ın yapılandırmasına eklenir. macOS'ta dosya
`~/Library/Application Support/Claude/claude_desktop_config.json`, Windows'ta `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "square": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/bin.js"],
      "env": {
        "SQUARE_MCP_CLUSTER": "devnet",
        "SQUARE_MCP_RPC_URL": "https://api.devnet.solana.com",
        "SQUARE_PROGRAM_ID_REGISTRY": "AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9",
        "SQUARE_PROGRAM_ID_POLICY": "63HKPj2L8a9DGeTa9Eh3NaZXthMrFUEgbs9Y28SNEc4",
        "SQUARE_PROGRAM_ID_VERIFIER": "8yLdDR5zoAzeEWzkNX19DKy4HfVYXb7VcU3wWStwTFPh",
        "SQUARE_PROGRAM_ID_ESCROW": "6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX",
        "SQUARE_MCP_LOOKUP_TABLE": "3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG",
        "SQUARE_MCP_TIMEOUT_MS": "10000",
        "SQUARE_MCP_CARD_MAX_BYTES": "65536"
      }
    }
  }
}
```

`node` Claude Desktop'ın PATH'inde değilse mutlak yolu yazılır (`which node`). Repo macOS'un korumalı bir
klasöründeyse (Masaüstü, Belgeler) Claude Desktop dosyayı açamaz (`EPERM`). İzin vermeden, sunucunun kendi
bağımlılıklarıyla bir kopyası başka bir dizine kurulur ve `args` o kopyanın `dist/bin.js`'ini gösterir:

```bash
pnpm --filter @squaresdk/solana-mcp deploy --prod --legacy ~/.local/share/square-mcp
```

Claude Desktop yapılandırma dosyasını kapanırken yeniden yazar: dosya Desktop kapalıyken düzenlenir. Claude Desktop yeniden başlatılınca
araçlar görünür. Örnek istekler:
- "Square'de 52gx… agent'ının kabul bekleyen işleri hangileri?"
- "Square devnet'te kasada ne kadar USDC kilitli?"

Claude Code: `claude mcp add square -e SQUARE_MCP_CLUSTER=devnet -e … -- node <repo>/packages/mcp/dist/bin.js`.

## Havuzlu istemci

```ts
import { McpClientPool } from '@squaresdk/solana-mcp/client';

const pool = new McpClientPool({
  servers: {
    square: { type: 'stdio', command: 'node', args: ['dist/bin.js'], env },
    search: { type: 'http', url: 'https://tools.example.com/mcp', headers },
  },
  maxConcurrency: 4,
  toolCacheTtlMs: 60_000,
  requestTimeoutMs: 30_000,
  reconnect: { maxAttempts: 3, backoffMs: 200, maxBackoffMs: 2_000 },
});
const work = await pool.callTool('square', 'square_find_work', { agentRecord });
const quote = await pool.callToolByName('search_quote', { query }); // tool'u sunan tek sunucu bulunur
```

- **Bağlantı:** Sunucu başına tek bağlantı, ilk istekte açılır ve yeniden kullanılır.
- **Eşzamanlılık:** Sunucu başına aynı anda en fazla `maxConcurrency` istek yürür; fazlası sırada bekler.
- **Yeniden bağlanma:** Kopan bağlantı sonraki istekte yeniden açılır. Açılış üstel beklemeyle `maxAttempts`
  kez denenir; tükenince `connect_failed` hatası döner.
- **Yeniden deneme yok:** Yolda kopan araç çağrısı yeniden denenmez; yazma araçları idempotent değildir.
  Yalnızca `listTools` bir kez yeniden denenir.
- **Araç keşfi:** Araç listesi `toolCacheTtlMs` boyunca önbellekte tutulur. Sunucunun `tools/list_changed`
  bildirimi ve yeniden bağlanma önbelleği düşürür. `listAllTools`, `findTool` ve `callToolByName` bütün
  sunucularda arar; araç birden çok sunucudaysa `ambiguous_tool` döner.
- **Taşımalar:** stdio, Streamable HTTP ve özel taşıma (`type: 'transport'`).

## Testler

`pnpm --filter @squaresdk/solana-mcp test`:
- **Araçlar:** Gerçek bir MCP istemcisinden, bellek içi taşımayla ve bellekteki zincire karşı.
- **İmza akışı:** Anahtarsız modda imzasız tx döner, hiçbir şey gönderilmez. Anahtar rolünse imzalanıp gönderilir.
  Başka rolün tx'i kurulmaz. İmzasız tx gönderilmez.
- **Havuz:** Yeniden kullanım, eşzamanlılık sınırı, yeniden bağlanma, araç önbelleği, sunucular arası keşif, kapatma.
- **Taşımalar:** stdio'da derlenmiş sunucu açılır; Streamable HTTP bir HTTP sunucusuna karşı denenir.
