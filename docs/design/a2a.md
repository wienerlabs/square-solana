# A2A görev protokolü

**Paket:** `@squaresdk/solana-a2a` ([`packages/a2a`](../../packages/a2a)) · **Issue:** BE-17 (#50) · **Protokol:** [A2A v1.0](https://a2a-protocol.org/v1.0.0/specification/) (a2aproject/A2A v1.0.1), JSON-RPC 2.0 bağlaması · **Sözleşme:** [api-sdk-contract.md](api-sdk-contract.md) v0.6.0

Bir agent'ın iş aldığı uç nokta. Kurumun agent'ı (A2A istemcisi) işi bir görev olarak gönderir; işi yapan agent (A2A sunucusu) görevi zincirdeki escrow `Job`'una bağlar ve job ilerledikçe görevi ilerletir. Görevler Postgres'te kalıcıdır, canlı durum SSE ile akar. Şemalar `@squaresdk/solana-types` içindeki `a2a.ts`'tedir.

## 1. Kapsam

| Var | Yok (gerekçe) |
|---|---|
| JSON-RPC sunucusu (`createA2aServer`, `node:http` işleyicisi) | Push bildirimleri: yöntemler `-32003` döner; agent sunucusunun dışarıya istek atması SSRF yüzeyi açar, ihtiyaç doğarsa BE-13 korumalarıyla |
| İstemci (`createA2aClient`) | `GetExtendedAgentCard`: `-32007`; kart barındırma BE-18 (`putAgentCard`, `agent_cards`) ve BE-19'da |
| Postgres görev deposu (`@squaresdk/solana-a2a/prisma`) | gRPC ve HTTP+JSON bağlamaları; Square yalnızca JSON-RPC sunar |
| Square kapısı: görevi açan mesaj zincirdeki job'a bağlanır | Çok kiracılık: istekteki `tenant` yok sayılır, bir sunucu tek bir `AgentRecord`'a hizmet eder |
| Görev durum makinesi ve job eşlemesi | Cüzdan imzalı istekler: BE-13; şimdilik API anahtarı |

Issue'daki dört mesaj A2A v1.0 yöntemlerine şöyle karşılık gelir: **create** `SendMessage` / `SendStreamingMessage`, **status** `GetTask`, `ListTasks` ve akıştaki `statusUpdate`, **cancel** `CancelTask`, **artifact** `Task.artifacts` ve akıştaki `artifactUpdate`.

## 2. Yöntemler

| Yöntem | Davranış |
|---|---|
| `SendMessage` | `message.taskId` yoksa görev açar (§4), varsa göreve devam mesajı ekler. `configuration.returnImmediately: true` görevi hemen döner; aksi halde görev terminal ya da kesintili duruma gelene kadar, en fazla `blockingTimeoutMs` bekler ve güncel görevi döner. Sonuç her zaman `task`'tır |
| `SendStreamingMessage` | `SendMessage` gibi açar; yanıt SSE akışıdır (§5) |
| `GetTask` | Görevi zincirle uzlaştırır (§3.3) ve döner. `historyLength` en fazla `maxHistory` |
| `ListTasks` | Yalnızca çağıranın görevleri; `contextId`, `status`, `statusTimestampAfter` süzgeçleri; `pageSize` 1 ile 100 arası (varsayılan 50), `pageToken` imleçtir. Geçmiş yalnızca `historyLength` verilirse, artefaktlar yalnızca `includeArtifacts: true` ise döner |
| `CancelTask` | Job zincirde kabul edilmeden önce (`open`, `funded`) ya da job iptal edilmişse (`cancelled`) görevi `CANCELED` yapar ve agent'ın sinyalini keser; aksi halde `-32002`. İptal edilmiş görevde tekrar çağrı aynı görevi döner |
| `SubscribeToTask` | Terminal olmayan göreve SSE akışı; terminal görevde `-32004` |
| `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig` | `-32003` |
| `GetExtendedAgentCard` | `-32007` |

Görevi ilerleten agent kodudur (`TaskExecutor`). Sunucu yeni görevde `onTask(context)`'i, devam mesajında `onMessage(context, message)`'ı çağırır. `context` şu geçişleri sunar: `working`, `requireInput`, `addArtifact` (`append`, `lastChunk`), `complete`, `fail`, `reject`. Her geçiş §3'teki kurallarla zincirden taze okunan job'a karşı denetlenir; kurala uymayan geçiş hata fırlatır ve görev değişmez. `onTask` hata fırlatırsa görev, kurallar izin veriyorsa `FAILED` olur.

## 3. Görev durumu ↔ job durumu

**İlke: görev agent'ın işidir.** Görev, agent'ın kendi işi hakkında söylediğidir; job, zincirin para hakkında söylediğidir. A2A'nın `COMPLETED`'ı "iş teslim edildi" demektir, "ödeme yapıldı" demek değildir. Ödeme, iade ve dispute görev durumunu değiştirmez; yanıtta `metadata.square.jobStatus` ve `metadata.square.slot` olarak raporlanır.

### 3.1 Job durumu → görev durumu

`JOB_STATUS_TO_TASK_STATE` (`@squaresdk/solana-types`). Job geçişleri [program-interface.md](program-interface.md) §6'daki escrow durum makinesindendir.

| Job durumu | Job'u bu duruma getiren | Görev durumu | Not |
|---|---|---|---|
| `open` | `create_job` (kurum) | `TASK_STATE_SUBMITTED` | |
| `funded` | `fund_job` (kurum) | `TASK_STATE_SUBMITTED` | Görev en çok bu durumda açılır |
| `accepted` | `accept_job` (agent) | `TASK_STATE_WORKING` | |
| `delivered` | `submit_work` (agent) | `TASK_STATE_COMPLETED` | Teslim; challenge penceresi açık |
| `disputed` | `raise_dispute` | `TASK_STATE_COMPLETED` | `jobStatus: disputed` |
| `resolved` | `resolve_dispute` | `TASK_STATE_COMPLETED` | `jobStatus: resolved` |
| `released` | `finalize_payment`, `execute_resolution` | `TASK_STATE_COMPLETED` | Ödeme agent tarafına |
| `refunded` | `finalize_payment` (Refused), `execute_resolution` (FavorInstitution) | `TASK_STATE_COMPLETED` | Ödeme kuruma döndü; yalnızca teslimden sonra olur |
| `cancelled` | `cancel_job` (kurum) | `TASK_STATE_CANCELED` | Kabulden önce ya da kabulden sonra deadline geçince |

### 3.2 Görev durumu → izin verilen job durumları

Agent'ın yazdığı her durum zincirdeki job ile tutarlı olmalıdır (`consistentWithJob`):

| Görev durumu | Job durumu | Anlamı |
|---|---|---|
| `TASK_STATE_SUBMITTED` | `open`, `funded` | İş henüz kabul edilmedi |
| `TASK_STATE_WORKING` | `accepted` | Agent `accept_job`'u zincirde yapmış olmalı |
| `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED` | `open`, `funded`, `accepted` | Agent istemciden girdi ya da kimlik bekliyor; akış açık kalır |
| `TASK_STATE_COMPLETED` | `delivered`, `disputed`, `resolved`, `released`, `refunded` | Agent `submit_work`'ü zincirde yapmış olmalı |
| `TASK_STATE_FAILED` | `open`, `funded`, `accepted` | Agent işi bırakır; job kurumun `cancel_job`'una kadar zincirde kalır |
| `TASK_STATE_REJECTED` | `open`, `funded` | Agent işi kabul etmeden reddeder |
| `TASK_STATE_CANCELED` | `open`, `funded`, `cancelled` | İstemci iptali ya da zincirde iptal |

### 3.3 Kurallar

- **Terminal görev değişmez.** `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` bir daha değişmez ve mesaj kabul etmez (spec §3.1.6). Job hâlâ `open` ya da `funded` ise terminal görevden sonra aynı job için yeni görev açılabilir.
- **Geçişler:** Terminal olmayan bir görev herhangi bir duruma geçebilir; `SUBMITTED`'a yalnızca kesintili durumdan (`INPUT_REQUIRED`, `AUTH_REQUIRED`) dönülür (`canTransition`).
- **Uzlaştırma yalnızca ileri gider.** `GetTask`, `CancelTask` ve `SubscribeToTask` job'u zincirden okur (`reconcile`): job `accepted` olunca `SUBMITTED` görev `WORKING` olur; job'un karşılığı terminal bir durumsa görev o duruma geçer. Görev hiçbir zaman geri gitmez, terminal görev job ne olursa olsun aynı kalır.
- **Tek etkin görev:** Bir job için aynı anda yalnızca bir terminal olmayan görev olur; ikincisi `JOB_HAS_ACTIVE_TASK` ile reddedilir.
- **İptal:** İstemci yalnızca agent job'u zincirde kabul etmeden önce iptal edebilir. Kabulden sonra iş zincirdeki yoldan çözülür (`submit_work` ya da deadline sonrası `cancel_job`).

## 4. Square bağlaması: görevi açan mesaj

Görevi açan mesaj `message.metadata.square = { job, specHash }` taşır. Sunucu, `createChainJobSource` ile escrow `Job` hesabını SDK üzerinden okur ve şunları denetler:

| Denetim | Red sebebi (`ErrorInfo.reason`, kod `-32602`) |
|---|---|
| `metadata.square.job` ve `specHash` var ve biçimleri doğru | `SQUARE_METADATA_REQUIRED` |
| Job zincirde var | `JOB_NOT_FOUND` |
| Job'un `agent_record`'u bu sunucunun `AgentRecord`'u | `JOB_NOT_FOR_AGENT` |
| Job `open` ya da `funded` | `JOB_NOT_OPEN` (`metadata.jobStatus`) |
| `specHash` job'un `spec_hash`'i; mesajda `data` parçası varsa ilkinin RFC 8785 + SHA-256'sı da aynı | `SPEC_HASH_MISMATCH` |
| `message.contextId` verilmişse job adresi | `CONTEXT_ID_REJECTED` |

Görevin `contextId`'si job adresidir; görev kimliği sunucuda üretilen UUID'dir. Aynı çağıran aynı `messageId` ile aynı içeriği yeniden gönderirse aynı görevi alır (yeniden deneme güvenli); farklı içerikle gönderirse `MESSAGE_ID_CONFLICT`. İçerik karşılaştırması mesajın kimlikler dışındaki alanlarının RFC 8785 + SHA-256'sıyladır (`messageContentHash`).

Devam mesajında (`message.taskId` dolu) `contextId` görevinkiyle aynı olmalıdır (`CONTEXT_ID_MISMATCH`); terminal göreve (`TASK_TERMINAL`) ya da `onMessage` tanımlamayan agent'a (`CONTINUATION_NOT_SUPPORTED`) devam mesajı `-32004` ile reddedilir. İstemci mesajının rolü `ROLE_USER` olmalıdır.

## 5. Akış (SSE)

- Yanıt `text/event-stream`'dir. Her olay bir `data:` satırında, sonucu `StreamResponse` olan bir JSON-RPC yanıtıdır (spec §9.4.2). `StreamResponse` `task`, `message`, `statusUpdate` ya da `artifactUpdate` alanlarından tam olarak birini taşır.
- İlk olay görevin anlık görüntüsüdür (`task`), sonra `statusUpdate` ve `artifactUpdate` olayları görev sürümü sırasıyla gelir. Anlık görüntüden önce yayımlanan olaylar bekletilir, sürümü görüntüden eski olanlar atlanır. Terminal `statusUpdate`'ten sonra akış kapanır; kesintili durumlarda açık kalır.
- Kalp atışı `heartbeatMs`'de bir `: ping` yorum satırıdır. Akış en fazla `streamMaxDurationMs` sürer. Yazılmayı bekleyen veri `4 × maxBodyBytes`'ı aşarsa (yavaş tüketici) akış kapanır. İstemci `SubscribeToTask` ve `GetTask` ile kaldığı yerden devam eder.
- Eşzamanlı akış sayısı toplamda `maxStreams`, çağıran başına `maxStreamsPerCaller` ile sınırlıdır. Yer görev açılmadan ayrılır: sınır aşılınca HTTP 429 (`-32000`) döner ve görev oluşmaz.
- Canlı olaylar süreç içi veriyolundadır (`createTaskEventBus`). Kalıcı olan depodur; birden fazla sunucu örneği arasında olay dağıtımı açık noktadır (§10).

## 6. Kimlik ve güvenlik

- **Kimlik:** Her istek `Authenticator` ile doğrulanır, doğrulanamazsa HTTP 401 (`-32000`). Görev yalnızca onu açan çağırana görünür; başka çağırana `-32001` döner, görevin varlığı sızmaz.
- **API anahtarı:** `createApiKeyAuthenticator({ keySha256 })` `x-api-key` başlığının SHA-256'sını izinli listeyle sabit zamanda karşılaştırır. Anahtarın kendisi sunucuda tutulmaz; çağıran kimliği `api-key:<sha256>`'dır. Cüzdan imzalı istekler BE-13'te.
- **Sürüm:** `A2A-Version` başlığı ya da sorgu parametresi `1.0` olmalıdır. Boş değer 0.3 sayılır ve `-32009` döner (spec §3.6.2).
- **Girdi:** Yalnızca `POST` (405), `content-type: application/json` (415), gövde en fazla `maxBodyBytes` (413, bağlantı kapanır), toplu istek yok (`-32600`). Parametreler zod ile doğrulanır; hatalar alan yollarıyla `google.rpc.BadRequest` olarak döner. Mesaj başına en fazla 64 parça, kimlikler en fazla 256 karakter; parça URL'leri yalnızca `https`, `http` ya da `ipfs`.
- **Hata ayrıntısı:** Tel üzerindeki mesajlar spesifikasyonun standart metinleridir. Depo ve agent hataları `-32603` olarak döner, ayrıntı yalnızca `onError`'a gider.
- **İstemci:** Varsayılan olarak yalnızca `https` uç noktası (`allowInsecureHttp` yalnızca yerel geliştirme ve testler için). Yönlendirme izlenmez (`redirect: 'error'`), yanıt ve akış olayı boyutu `maxResponseBytes` ile sınırlıdır, akışta olaylar arası bekleme `timeoutMs`'i aşınca bağlantı kesilir. Yanıtlar zod ile doğrulanır, yanıt kimliği istekle eşleşmelidir; uymayan yanıt `-32006`'dır.

## 7. Kalıcı depo

`TaskStore` arayüzü depoyu soyutlar. Postgres uygulaması `createPrismaTaskStore(client)` ayrı alt yoldadır (`@squaresdk/solana-a2a/prisma`); `@squaresdk/solana-db`'ye yalnızca tip olarak bağlıdır, istemciyi çağıran verir. Tablolar `a2a_tasks` ve `a2a_messages` ([data-model.md](data-model.md) §2, zincir dışı tablolar).

- **Eşzamanlılık:** Her görev satırının `version` sütunu vardır; güncelleme beklenen sürümle yapılır, çakışmada sunucu taze okuyup yeniden dener.
- **Tek etkin görev:** Görev açma bir işlemde, `(agent_record, job)` üzerine `pg_advisory_xact_lock` alınarak yapılır; job için terminal olmayan görev varsa açılmaz.
- **Tekrar deneme:** `(agent_record, caller, create_message_id)` tekildir; aynı mesaj aynı görevi döner. `a2a_messages`'ta `(task_id, message_id)` tekildir; geçmiş ekleme sırasıyla (`bigserial`) döner.
- **Biçim kısıtları:** Adres ve hash sütunları CHECK kısıtlarıyla zorlanır (`db/scripts/check-constraints.mjs`).
- **Yeniden başlatma:** Görev, durumu, artefaktları ve geçmişi süreç belleğinde tutulmaz; sunucu yeniden başladığında depodan okunur (`test/two-agents.test.ts`).

## 8. Hata kodları

| Kod | Ne zaman |
|---|---|
| `-32700` | Gövde JSON değil |
| `-32600` | JSON-RPC 2.0 isteği değil, toplu istek, yanlış content-type (HTTP 415) ya da büyük gövde (HTTP 413) |
| `-32601` | Bilinmeyen yöntem |
| `-32602` | Geçersiz parametre (`BadRequest`) ya da §4'teki Square sebepleri (`ErrorInfo`) |
| `-32603` | İç hata; ayrıntı tel üzerinde yok |
| `-32001` | Görev yok ya da çağırana ait değil |
| `-32002` | Görev iptal edilemez (§3.3) |
| `-32003` | Push bildirimleri desteklenmiyor |
| `-32004` | Terminal göreve abonelik ya da devam mesajı, devam mesajı desteklenmiyor |
| `-32006` | İstemci: agent yanıtı geçersiz |
| `-32007` | Genişletilmiş agent kartı yok |
| `-32009` | Desteklenmeyen A2A sürümü |
| `-32000` | Kimlik doğrulanamadı (HTTP 401) ya da akış sınırı (HTTP 429) |

## 9. Kaynaklardan farklar

| Kaynak | Ne oldu |
|---|---|
| aip-beta `src/lib/protocol/` @ `5a36fe0` (`a2a-client.ts`, `a2a-dispatcher.ts`, `task-machine.ts`, `messages.ts`) | Kopyalanmadı, A2A v1.0'a göre yeniden yazıldı. AIP standart dışı `task/create` ve yoklamalı `task/status` yöntemlerini kullanıyordu; yerlerini v1.0 yöntemleri ve SSE aldı. Görev makinesi kimlik doğrulama, ödeme kilidi ve istek gönderme gibi platform adımlarını görev durumu olarak tutuyordu; Square'de bu adımlar zincirdeki job'dadır ve görev durumu job'dan türetilir (§3). Bellek içi `Map` ve Supabase'e ateşle-unut yazım yerine Postgres deposu ve iyimser sürüm (§7). `a2a-dispatcher.ts`'in hosted agent ve agent memory bağları kapsam dışı |
| aip-beta `agent-card-store.ts`, `well-known-cache.ts` | Taşınmadı ([BE-02](../provenance/BE-02.md)). Bellek içi kart deposunun karşılığı `agent_cards` tablosudur (kalıcı, zincirdeki kart hash'iyle doğrulanır; yazan BE-18 `putAgentCard`); A2A katmanı kart önbelleklemez |
| covenant `app/lib/aip/a2a.ts` | Kopyalanmadı: `app/` LGPL-2.1 ve yeniden lisanslama onayı (BC-03) bekleniyor. Yalnızca davranış referansı (`task/create`, `task/status`, beş durum) |
| Square (EVM) `docs/a2a/README.md` | Referans: görev ile job'un iki ayrı durum makinesi olduğu ve A2A `COMPLETED`'ın ödeme anlamına gelmediği ilkesi §3'te korunur. Fark: Solana'da `WORKING` ve `COMPLETED`, agent'ın zincirdeki `accept_job` ve `submit_work`'üne bağlıdır |

## 10. Açık noktalar

1. **Agent kartı (BE-19):** Repodaki `AgentCardSchema`'da A2A v1.0'ın `supportedInterfaces` alanı yok; dış istemciler uç noktayı bu alandan okur. Kartın v1.0'a hizalanması BE-19'da (`createAgent`, `/.well-known/agent-card.json`).
2. **Birden fazla sunucu örneği:** Olay veriyolu süreç içidir. Aynı agent birden fazla örnekle çalışacaksa olaylar örnekler arasında dağıtılmalı (ör. Postgres `LISTEN/NOTIFY`); o zamana kadar akışlar görevi işleyen örnekten açılır.
3. **Cüzdan imzalı kimlik (BE-13):** API anahtarı yerine çağıranın cüzdan imzası; `Authenticator` arayüzü değişmez.
4. **Uzun bekleme:** Akışsız `SendMessage` en fazla `blockingTimeoutMs` bekler; daha uzun işler için istemci `returnImmediately` ile açıp akışa abone olur.
