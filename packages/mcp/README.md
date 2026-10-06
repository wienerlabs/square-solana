# @squaresdk/solana-mcp

Square'in Model Context Protocol paketi (BE-28). İki yönlüdür:

- **Square MCP sunucusu** (`square-mcp`): Claude Desktop, Claude Code, Cursor ya da otonom bir agent Square'deki
  işleri bulur, job'ları ve itibarı okur, job açar, işe alır ve teslim eder. Okuma tool'ları cüzdan istemez;
  yazma tool'ları **imzasız** tx hazırlar, imzayı kullanıcının cüzdanı atar.
- **Havuzlu MCP istemcisi** (`@squaresdk/solana-mcp/client`): bir agent'ın birden çok MCP sunucusuna (Square MCP,
  başka agent'ların ya da araçların sunucuları) bağlantılarını tek havuzda yönetir.

Veri kaynağı Square REST API'sidir ([`apps/api`](../../apps/api/README.md), sözleşme
[`docs/api/openapi.yaml`](../../docs/api/openapi.yaml)); istemci SDK'nın `createApiClient`'ıdır. Zincire yalnızca
API'nin vermediği üç iş için gidilir: settlement mint'i ve Travel Rule eşiği (`EscrowConfig`), job açılışında
job hesabının güncel durumu (indexer gecikmesi adımı yanlış seçtirmesin) ve imzalı tx'in gönderimi.

## Tool'lar

Tool açıklamaları ve sonuçları agent'a yöneliktir ve apps/web arayüzü gibi İngilizcedir. Sonuç gövdesi JSON
metnidir; API hataları kodu ve zincir hatasıyla (`programError`) aynen döner. Tutarlar settlement mint'inin taban
birimindedir (u64 ondalık dize), zamanlar ISO 8601.

| Tool | Ne yapar | Kip |
|---|---|---|
| `square_find_work` | İş bulma: varsayılan `funded` (kabul bekleyen) işler; durum, agent, kurum, politika, tutar süzgeci | okuma |
| `square_get_job` | Job: durum, zaman çizelgesi (indexlenmiş event'ler), dispute, alacak (claim), release proof, validation, sonraki adım | okuma |
| `square_settlement_stats` | Durum başına job sayıları, kilitli escrow, dispute ve release oranları, keeper sonuçları; isteğe bağlı hacim ve challenge penceresi | okuma |
| `square_get_reputation` | AgentRecord'a bağlı itibar (tamamlanan / başarısız / dispute, kazanç, başarı oranı) ve ödeme cüzdanının screening'i | okuma |
| `square_discover_agents` | Agent keşfi: beceri kimliği ya da etiketi, fiyat, doğrulanmış kart; kart bilgisi ve itibara göre sıra | okuma |
| `square_open_job` | Job açma: aynı spec'le her çağrıda sıradaki tx — `create_job` → (eşik üstünde) `commit_travel_rule` → `fund_job` | yazma |
| `square_accept_job` | Fonlanmış işi bağlı agent cüzdanıyla kabul (`accept_job`) | yazma |
| `square_deliver_work` | Teslimatı API'ye yükler (ya da yayımlanmış `workHash` + `deliveryUri`) ve `submit_work` hazırlar | yazma |
| `square_submit_signed_transaction` | İmzalı tx'i gönderir ve onayı bekler | yazma |

Okuma tool'ları Covenant MCP'nin beş salt okunur tool'unun (`covenant_*`) Square karşılıklarıdır; yazma
tool'ları yalnızca yazma kipinde kaydedilir.

## İmza akışı

Sunucu özel anahtar tutmaz.

1. Yazma tool'u API'nin `POST /v1/tx` ucundan imzasız v0 tx'i alır (hesap çözümü, compute unit sınırı ve
   simülasyon sunucuda; düşecek tx `simulation_failed` + `programError` ile döner).
2. Tool tx'i base64 olarak ve çözülmüş özetiyle döner: fee payer, zorunlu imzacılar ve imza durumları, talimatların
   programları (`square_escrow`, `compute_budget`), `lastValidBlockHeight`. API'nin döndürdüğü tx dönmeden önce
   denetlenir: fee payer istenen cüzdandır; talimatlar yalnızca compute budget (`set_compute_unit_limit`,
   `set_compute_unit_price`, her biri en fazla bir kez) ve yapılandırılmış escrow programının tek talimatıdır;
   o talimatın verisi istenen çağrının yerelde kodlanmış hâliyle bayt bayt aynıdır; tool'un verdiği hesaplar
   IDL'deki yerlerindedir; fiyat istendiyse tx'teki fiyat odur. Uymayan tx reddedilir (`prepared transaction
   rejected`): ele geçirilmiş bir API ya da araya giren biri talimat ekleyemez, tutarı ya da hesabı değiştiremez.
3. Kullanıcı tx'i kendi cüzdanında imzalar; imzalı tx `square_submit_signed_transaction`'a verilir.
4. Gönderimden önce her zorunlu imzacının imzası mesaj baytlarına karşı Ed25519 ile doğrulanır. Eksik ya da
   geçersiz imzalı tx RPC'ye **hiç gönderilmez** (`not_fully_signed`, imzacı başına durumla).

**Yerel imzalayıcı (isteğe bağlı, varsayılan kapalı).** `SQUARE_SIGNER_KEYPAIR` bir keypair dosyasını
(solana-keygen biçimi) gösterirse yazma tool'larına `sign: true` verilebilir: tx bu anahtarla imzalanır ve aynı
doğrulamadan geçip gönderilir; cüzdan girdisi verilmezse varsayılanı bu anahtarın adresidir. Başka bir imzacı da
gerekiyorsa kısmen imzalı tx döner, gönderilmez. Fiyat (`computeUnitPrice`) verilmezse yerel imza, API'nin koyduğu
fiyat compute unit başına 1 000 000 mikro-lamport'u (`LOCAL_SIGNING_MAX_COMPUTE_UNIT_PRICE`) aşıyorsa reddedilir;
daha yüksek bir priority fee açıkça verilir. Para taşıyan yazma tool'ları `destructiveHint: true` ile işaretlidir:
istemci onay isteyebilir.

> **Uyarı:** yerel imzalayıcı, bağlı agent'ın (ve onu yönlendiren her girdinin, ör. prompt injection) o anahtarla
> fon taşıyan tx imzalatabilmesi demektir. Yalnızca ayrı, sınırlı bakiyeli bir anahtarla ve güvendiğiniz bir agent
> döngüsünde kullanın; kullanıcı onayı gereken her yerde imzasız akışı tercih edin. Streamable HTTP taşımasında
> yerel imzalayıcı reddedilir: uzak istemci sunucunun anahtarıyla imza attıramaz.

## Yapılandırma

Değerler ortamdan okunur ve açılışta doğrulanır; dağıtıma bağlı hiçbir değerin varsayılanı yoktur.

| Değişken | Kip | Anlamı |
|---|---|---|
| `SQUARE_API_URL` | zorunlu | Square REST API'sinin kökü |
| `SQUARE_NETWORK` | zorunlu | Agent'a bildirilen ağ etiketi |
| `SQUARE_TIMEOUT_MS` | zorunlu | API ve RPC istek zaman aşımı; tx onayı da en çok bu kadar beklenir |
| `SQUARE_API_KEY` | yazmada zorunlu | `X-API-Key`; kapsamlar: `read` (verilirse okuma da anahtarla gider), `tx:prepare`, `deliveries:write` |
| `SQUARE_RPC_URL` | yazma | Solana JSON-RPC ucu |
| `SQUARE_ESCROW_PROGRAM_ID` | yazma | `square_escrow` program kimliği |
| `SQUARE_SIGNER_KEYPAIR` | isteğe bağlı | Yerel imzalayıcı keypair dosyası (yalnızca yazma kipi ve stdio) |
| `SQUARE_MCP_HTTP_HOST`, `SQUARE_MCP_HTTP_PORT` | `--http` | Streamable HTTP dinleme adresi |
| `SQUARE_MCP_ALLOWED_HOSTS` | isteğe bağlı | Virgülle ayrılmış izinli `Host` adları; verilirse diğerleri 403 (DNS rebinding koruması) |

`SQUARE_RPC_URL` ve `SQUARE_ESCROW_PROGRAM_ID` birlikte verilir; ikisi de yoksa sunucu yalnızca okuma kipinde
açılır. Teslimat yüklemesinde API anahtarının sahibi job'un agent cüzdanı ya da agent kaydının sahibi olmalıdır.

## Kurulum

Paket ADR 0001'in yayın ön koşulları tamamlanana kadar npm'de değildir (`pnpm pack` tarball'ı kurulabilir,
`scripts/ci/pack-smoke.mjs`). Depodan:

```bash
pnpm install
pnpm turbo run build --filter @squaresdk/solana-mcp...
node packages/mcp/dist/bin.js --help
```

Yayından sonra `npx -y @squaresdk/solana-mcp` aynı `square-mcp` komutunu çalıştırır.

### Claude Desktop

`claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "square": {
      "command": "node",
      "args": ["/path/to/square-solana/packages/mcp/dist/bin.js"],
      "env": {
        "SQUARE_API_URL": "https://api.example.com",
        "SQUARE_NETWORK": "devnet",
        "SQUARE_TIMEOUT_MS": "15000",
        "SQUARE_API_KEY": "sqk_…",
        "SQUARE_RPC_URL": "https://rpc.example.com",
        "SQUARE_ESCROW_PROGRAM_ID": "<square_escrow program kimliği>"
      }
    }
  }
}
```

Yalnızca okuma için son üç satır çıkarılır. Claude Desktop yeniden başlatılınca tool'lar görünür; örnek istekler:
"Square'de agent kaydım `<agentRecord>` için fonlanmış iş var mı?", "`<job>` job'unun durumu ve zaman çizelgesi",
"çeviri becerisi olan, en az 5 iş tamamlamış agent'lar".

### Claude Code

```bash
claude mcp add square \
  -e SQUARE_API_URL=https://api.example.com -e SQUARE_NETWORK=devnet -e SQUARE_TIMEOUT_MS=15000 \
  -- node /path/to/square-solana/packages/mcp/dist/bin.js
```

### Streamable HTTP

```bash
SQUARE_MCP_HTTP_HOST=127.0.0.1 SQUARE_MCP_HTTP_PORT=8790 SQUARE_MCP_ALLOWED_HOSTS=mcp.example.com \
  SQUARE_API_URL=… SQUARE_NETWORK=… SQUARE_TIMEOUT_MS=… node packages/mcp/dist/bin.js --http
```

- Uç `/mcp`'dir, `GET /health` süreç sağlığını verir.
- Oturumludur: `initialize` yeni oturum ve kendi sunucu örneğini açar, sonraki istekler `Mcp-Session-Id` ile gelir,
  `DELETE` oturumu kapatır.
- İstek gövdesi 4 MiB ile sınırlıdır.
- Kimlik doğrulama ve TLS önündeki ters vekilin işidir.

## Havuzlu istemci

```ts
import { McpClientPool } from '@squaresdk/solana-mcp/client';

const pool = new McpClientPool({
  servers: {
    square: { type: 'stdio', command: 'square-mcp', env: { SQUARE_API_URL: '…', SQUARE_NETWORK: '…', SQUARE_TIMEOUT_MS: '…' } },
    translator: { type: 'http', url: 'https://translator.example/mcp', headers: { authorization: 'Bearer …' } },
  },
  maxConcurrency: 4,
  toolCacheTtlMs: 60_000,
  requestTimeoutMs: 30_000,
  reconnect: { maxAttempts: 3, backoffMs: 250, maxBackoffMs: 5_000 },
});

const { tools, errors } = await pool.listAllTools(); // her tool'da `server`
const work = await pool.callTool('square', 'square_find_work', { agentRecord: '…' });
await pool.callToolByName('translate', { text: '…' }); // tool tek sunucuda olmalı
await pool.close();
```

| Özellik | Davranış |
|---|---|
| Bağlantı yeniden kullanımı | Sunucu başına tek `Client`, ilk istekte açılır; eşzamanlı açılışlar aynı bağlantıyı bekler |
| Eşzamanlılık sınırı | Sunucu başına `maxConcurrency` istek; fazlası sırayla bekler (`stats(server)`) |
| Yeniden bağlanma | Kopan bağlantı sonraki istekte yeniden açılır; açılış üstel beklemeyle `maxAttempts` kez denenir. Yolda kopan tool çağrısı yeniden denenmez (tx gönderimi gibi tool'lar idempotent değildir); `listTools` bir kez yeniden denenir |
| Tool keşfi önbelleği | Sunucu başına `toolCacheTtlMs`; `notifications/tools/list_changed` ve yeniden bağlanma önbelleği düşürür, `refresh: true` atlar |
| Kapatma | `close()` bağlantıları kapatır, kuyruktakileri `closed` hatasıyla reddeder; sonraki istekler hata alır |

Hedefler: `stdio` (alt süreç), `http` (Streamable HTTP) ve `transport` (her denemede yeni bir özel taşıma, ör.
bellek içi). Hatalar `McpPoolError`'dır (`unknown_server`, `closed`, `connect_failed`, `tool_not_found`,
`ambiguous_tool`).

## Testler

`pnpm --filter @squaresdk/solana-mcp test` (önce `build`; turbo'da `test` `build`'e bağlı).

- Square API'si ve Solana RPC yerel fixture sunucularıdır; görünümler `@squaresdk/solana-types` şemalarıyla kurulur.
- **Her tool:** SDK'nın gerçek MCP `Client`'ıyla, bellek içi taşımadan.
- **İmza akışı:** imzasız, kısmen imzalı ve geçersiz imzalı tx'in gönderilmediği; yerel imzalayıcı.
- **Zincir erişimi:** gerçek web3.js `Connection` ve Anchor istemcisiyle, IDL coder'ıyla kodlanmış hesaplar.
- **Uçtan uca stdio:** derlenmiş `dist/bin.js` alt süreç olarak açılır ve havuzun `stdio` hedefiyle (SDK'nın
  `StdioClientTransport`'u, Claude Desktop'ın kullandığı taşıma) okunur, job açılır, imzasız tx'in reddi ve
  imzalı tx'in gönderimi denenir.
- **Streamable HTTP:** `--http` süreci ve `startHttpServer`.
- **Havuz:** yeniden kullanım, eşzamanlılık, yeniden bağlanma, önbellek, kapatma.

## Kalanlar

- Gerçek Claude Desktop uygulamasıyla deneme yapılmadı. Yerine aynı stdio taşımasıyla SDK'nın istemcisi kullanıldı.
- Gerçek programlar ve gerçek API'yle (localnet / devnet) uçtan uca akış BE-36'dadır.
- npm yayını ADR 0001'in ön koşullarına bağlıdır. Paket diğer yayınlanabilir paketler gibi o zamana kadar
  `private: true` kalır; pack-smoke'ta yayınlanabilir olarak denetlenir.

## Köken

Covenant `mcp/` (Apache-2.0, `9894a41`) BE-02 ile geçmişiyle taşındı ve burada uyarlandı
([provenance](../../docs/provenance/BE-02.md)):

- `tools/discover.ts`: beş okuma tool'u `square_*` adlarıyla Square REST API'sine geçti. Covenant'ın hosted agent
  dizini yerine registry kayıtları ve agent card; cüzdana bağlı itibar yerine AgentRecord'a bağlı itibar.
- `config.ts`: `COVENANT_*` yerine `SQUARE_*`, yazma kipi ve yerel imzalayıcı.
- `http.ts`: API'nin HTTP istemcisiyken Streamable HTTP sunucusu oldu; API erişimi `api.ts`'te SDK istemcisiyle.
- `server.ts`: süreç girişi `bin.ts`'e ayrıldı; sunucu fabrikası taşımadan bağımsız.
- Yazma tool'ları, imza akışı ve havuzlu istemci yeni yazıldı. Covenant `sdk/examples/mcp-integration.ts` yalnızca
  kapsam için okundu: oradaki tool'lar ortamdaki özel anahtarla imzalayıp gönderiyordu, bu tasarımda sunucu anahtar
  tutmaz.
