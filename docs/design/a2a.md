# A2A görev protokolü

**Paket:** `@squaresdk/solana-a2a` ([`packages/a2a`](../../packages/a2a)) · **Issue:** BE-17 (#50) · **Protokol:** [A2A v1.0](https://a2a-protocol.org/v1.0.0/specification/) (a2aproject/A2A v1.0.1), JSON-RPC 2.0 bağlaması · **Sözleşme:** [api-sdk-contract.md](api-sdk-contract.md) v0.6.0

Bir agent'ın iş aldığı uç nokta. Kurumun agent'ı (A2A istemcisi) işi bir görev olarak gönderir; işi yapan agent (A2A sunucusu) görevi zincirdeki escrow `Job`'una bağlar ve job ilerledikçe görevi ilerletir. Görevler Postgres'te kalıcıdır, canlı durum SSE ile akar. Şemalar `@squaresdk/solana-types` içindeki `a2a.ts`'tedir.

## 1. Kapsam

| Var | Yok (gerekçe) |
|---|---|
| JSON-RPC sunucusu (`createA2aServer`, `node:http` işleyicisi) | Push bildirimleri: yöntemler `-32003` döner; agent sunucusunun dışarıya istek atması SSRF yüzeyi açar, ihtiyaç doğarsa BE-13 korumalarıyla |
| İstemci (`createA2aClient`) | `GetExtendedAgentCard`: `-32007`; kart barındırma BE-18 (`putAgentCard`, `agent_cards`) ve BE-19'da |
| Postgres görev deposu (`@squaresdk/solana-a2a/prisma`) | gRPC ve HTTP+JSON bağlamaları; Square yalnızca JSON-RPC sunar |
| Square kapısı: görevi açan mesaj zincirdeki job'a ve çağıranın kurumuna bağlanır | Çok kiracılık: istekteki `tenant` yok sayılır, bir sunucu tek bir `AgentRecord`'a hizmet eder |
| Görev durum makinesi ve job eşlemesi, yeniden başlatmada `resume()` | Cüzdan imzalı istekler: BE-13; şimdilik kuruma bağlanmış API anahtarı |

Issue'daki dört mesaj A2A v1.0 yöntemlerine şöyle karşılık gelir: **create** `SendMessage` / `SendStreamingMessage`, **status** `GetTask`, `ListTasks` ve akıştaki `statusUpdate`, **cancel** `CancelTask`, **artifact** `Task.artifacts` ve akıştaki `artifactUpdate`.

## 2. Yöntemler

| Yöntem | Davranış |
|---|---|
| `SendMessage` | `message.taskId` yoksa görev açar (§4), varsa göreve devam mesajı ekler. `configuration.returnImmediately: true` görevi hemen döner. Aksi halde görev kabul edildikten sonraki ilk kesintili ya da terminal durum olayına kadar, en fazla `blockingTimeoutMs` bekler; bekleyici agent işi başlamadan kurulur. İstemci bağlantıyı kapatırsa ya da sunucu kapanırsa bekleme biter. Sonuç her zaman `task`'tır |
| `SendStreamingMessage` | `SendMessage` gibi açar ya da devam eder; yanıt SSE akışıdır (§5) |
| `GetTask` | Görevi zincirle uzlaştırır (§3.3) ve döner. `historyLength` en fazla `maxHistory` |
| `ListTasks` | Yalnızca çağıranın görevleri; `contextId`, `status`, `statusTimestampAfter` süzgeçleri; `pageSize` 1 ile 100 arası (varsayılan 50), `pageToken` imleçtir. Geçmiş yalnızca `historyLength` verilirse, artefaktlar yalnızca `includeArtifacts: true` ise döner |
| `CancelTask` | Job zincirde kabul edilmeden önce (`open`, `funded`) ya da job iptal edilmişse (`cancelled`) görevi `CANCELED` yapar ve agent'ın sinyalini keser; aksi halde `-32002`. İptal edilmiş görevde tekrar çağrı aynı görevi döner |
| `SubscribeToTask` | Terminal olmayan göreve SSE akışı; terminal görevde `-32004` |
| `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig` | `-32003` |
| `GetExtendedAgentCard` | `-32007` |

Görevi ilerleten agent kodudur (`TaskExecutor`). Sunucu yeni görevde `onTask(context)`'i, devam mesajında `onMessage(context, message)`'ı çağırır; bir görevin agent işleri sırayla çalışır. Devam mesajı en az bir kez iletilir: `onMessage` bitene ya da görev terminal olana kadar mesaj depoda bekliyor işaretlidir; kapanış ya da çökmeyle yarım kalırsa yeniden başlatmada ya da aynı kimlikli tekrar denemede yeniden iletilir. Bu yüzden `onMessage` da tekrar çalıştırılabilir olmalıdır. `context` görevi açan çağıranın kimliğini (`caller`), job'u ve görevi açan mesajı taşır ve şu geçişleri sunar: `working`, `requireInput`, `addArtifact` (`append`, `lastChunk`), `complete`, `fail`, `reject`. Her geçiş §3'teki kurallarla zincirden taze okunan job'a karşı denetlenir; kurala uymayan geçiş hata fırlatır ve görev değişmez. `onTask` hata fırlatırsa görev, kurallar izin veriyorsa `FAILED` olur.

**Yeniden başlatma:** Agent işleri süreç içindedir. Sunucu yeniden başladıktan sonra `resume()` iş kurulacak görevleri zincirle uzlaştırır: bu süreçte başlamamış `SUBMITTED` ve `WORKING` görevler için `onTask`'ı görevi açan mesajla yeniden çağırır, işlenmemiş devam mesajlarını `onMessage`'a sırayla yeniden iletir. İş kurulmayacak görevler ilk okumada uzlaşır; zincirde terminal olmuş görevin bekleyen mesajları işlenmiş sayılır. Bu süreçte işi süren görevin `onTask`'ını yeniden başlatmaz, bekleyen mesajlarını ise kuyruğun sonuna ekler. `resume()` sunucu trafiğe açılmadan çağrılmalıdır; aksi halde yeni bir devam mesajı eskisinden önce işlenebilir ve trafiğin önce dokunduğu bir görevin `onTask`'ı bu süreçte yeniden başlamaz. `onTask` tekrar çalıştırılabilir olmalıdır (ör. job zaten `accepted` ise kabulü tekrarlamaz). `close()` yeni istekleri HTTP 503 ile reddeder, yeni agent işi başlatmaz, bekleyen `SendMessage` isteklerini güncel görevle yanıtlar, açık akışları kapatır, açılmak üzere olan akışı JSON 503 ile reddeder ve agent sinyallerini keser. Süren istek işleyicilerini beklemez: o sırada kapıyı geçmiş bir görev açılışı görevi kaydedebilir, agent işi başlamaz ve `resume()` ile sürer.

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

- **Terminal görev değişmez.** `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED` bir daha değişmez ve yeni mesaj kabul etmez (spec §3.1.6). Job hâlâ `open` ya da `funded` ise terminal görevden sonra aynı job için yeni görev açılabilir.
- **Geçişler:** Terminal olmayan bir görev herhangi bir duruma geçebilir; `SUBMITTED`'a yalnızca kesintili durumdan (`INPUT_REQUIRED`, `AUTH_REQUIRED`) dönülür (`canTransition`).
- **Uzlaştırma yalnızca ileri gider.** `GetTask`, `CancelTask`, `SubscribeToTask` ve devam mesajı job'u zincirden okur (`reconcile`): job `accepted` olunca `SUBMITTED` görev `WORKING` olur; job'un karşılığı terminal bir durumsa görev o duruma geçer. Görev hiçbir zaman geri gitmez, terminal görev job ne olursa olsun aynı kalır. Okuma yalnızca görev ya da job durumu değişince yazar; yanıttaki slot her okumada günceldir.
- **Zincir önce davranırsa:** Uzlaştırma görevi terminal yaparsa agent'ın sinyali kesilir. Agent'ın aynı terminal duruma geçişi (ör. `submit_work`'ten sonra `complete`) hata vermez, metni geçmişe eklenir.
- **Tek etkin görev:** Bir job için aynı anda yalnızca bir terminal olmayan görev olur; ikincisi `JOB_HAS_ACTIVE_TASK` ile reddedilir.
- **İptal:** İstemci yalnızca agent job'u zincirde kabul etmeden önce iptal edebilir. Kabulden sonra iş zincirdeki yoldan çözülür (`submit_work` ya da deadline sonrası `cancel_job`).

## 4. Square bağlaması: görevi açan mesaj

Görevi açan mesaj `message.metadata.square = { job, specHash }` taşır. Sunucu `createChainJobSource` ile escrow `Job` hesabını okur ve şunları denetler:

| Denetim | Red sebebi (`ErrorInfo.reason`, kod `-32602`) |
|---|---|
| `metadata.square.job` ve `specHash` var ve biçimleri doğru | `SQUARE_METADATA_REQUIRED` |
| Hesap var, sahibi escrow programı ve `Job` olarak çözülüyor | `JOB_NOT_FOUND` |
| Job'un `agent_record`'u bu sunucunun `AgentRecord`'u | `JOB_NOT_FOR_AGENT` |
| Job'un `institution`'ı çağıranın kurumlarından biri (§6) | `JOB_NOT_FOR_CALLER` |
| Job `open` ya da `funded` | `JOB_NOT_OPEN` (`metadata.jobStatus`) |
| `specHash` job'un `spec_hash`'i; mesajda `data` parçası varsa ilkinin RFC 8785 + SHA-256'sı da aynı | `SPEC_HASH_MISMATCH` |
| `message.contextId` verilmişse job adresi | `CONTEXT_ID_REJECTED` |

**Sahip denetimi:** Anchor'ın hesap çözücüsü yalnızca 8 baytlık ayırıcıya bakar; başka bir programın aynı düzende yazdığı hesap bu yüzden job sayılmaz, hesabın sahibi escrow programı olmalıdır. Escrow programı `Job` hesabını yalnızca `create_job`'da `["job", institution, spec_hash]` PDA'sında oluşturduğu için ayrıca PDA karşılaştırması yapılmaz.

**Kurum bağı:** Çağıran yalnızca adına yetkili olduğu kurumun job'u için görev açabilir. Bu denetim job durumundan ve etkin görev kuralından önce yapılır; kuruma ait olmayan çağıran job için görev olup olmadığını öğrenemez. `open` (fonlanmamış) job için de görev açılabilir, ancak agent `accept_job`'u job fonlanmadan yapamaz; pahalı iş `funded` ya da `accepted` job'da başlar.

Görevin `contextId`'si job adresidir; görev kimliği sunucuda üretilen UUID'dir. Aynı çağıran aynı `messageId` ile aynı içeriği yeniden gönderirse, job o arada ilerlemiş olsa da aynı görevi alır (tekrar deneme kapıdan önce aranır); farklı içerikle gönderirse `MESSAGE_ID_CONFLICT`. İçerik karşılaştırması mesajın kimlikler dışındaki alanlarının RFC 8785 + SHA-256'sıyladır (`messageContentHash`). Devam mesajları için de aynı kural geçerlidir; kaydedilmiş ama henüz işlenmemiş bir devam mesajının tekrarı onu agent'a yeniden iletir.

Devam mesajında (`message.taskId` dolu) `contextId` görevinkiyle aynı olmalıdır (`CONTEXT_ID_MISMATCH`). Terminal göreve (`TASK_TERMINAL`), `onMessage` tanımlamayan agent'a (`CONTINUATION_NOT_SUPPORTED`) ve geçmişi `maxMessagesPerTask` mesaja ulaşmış göreve (`TASK_MESSAGE_LIMIT`) devam mesajı `-32004` ile reddedilir; agent'ın kendi mesajları bu sınıra sayılır ama agent'ı engellemez. İstemci mesajının rolü `ROLE_USER` olmalıdır.

## 5. Akış (SSE)

- Yanıt `text/event-stream`'dir. Her olay bir `data:` satırında, sonucu `StreamResponse` olan bir JSON-RPC yanıtıdır (spec §9.4.2). `StreamResponse` `task`, `message`, `statusUpdate` ya da `artifactUpdate` alanlarından tam olarak birini taşır.
- İlk olay görevin anlık görüntüsüdür (`task`), sonra `statusUpdate` ve `artifactUpdate` olayları görev sürümü sırasıyla gelir. Anlık görüntüden önce yayımlanan olaylar bekletilir, sürümü görüntüden eski olanlar atlanır. Terminal `statusUpdate`'ten sonra akış kapanır; kesintili durumlarda açık kalır.
- İlk kare (görev ve geçmişi) SSE açılmadan hazırlanır; hazırlanamazsa istemci JSON hata yanıtı alır. İstemci akış açılmadan ayrıldıysa akış hemen kapanır ve yeri bırakılır.
- Kalp atışı `heartbeatMs`'de bir `: ping` yorum satırıdır. Akış en fazla `streamMaxDurationMs` sürer. Yazılmayı bekleyen veri `4 × maxBodyBytes`'ı aşarsa (yavaş tüketici) bağlantı hemen kesilir; kapanışta boşaltılamayan bağlantı bir kalp atışı süresi sonra kesilir. İstemci `SubscribeToTask` ve `GetTask` ile kaldığı yerden devam eder.
- Akışlar ve bekleyen (`returnImmediately` verilmeyen) `SendMessage` istekleri uzun isteklerdir; eşzamanlı sayıları toplamda `maxStreams`, çağıran başına `maxStreamsPerCaller` ile sınırlıdır. Yer görev açılmadan ayrılır: sınır aşılınca HTTP 429 (`-32000`) döner ve görev oluşmaz.
- Bir görevin yazmaları (agent geçişleri, artefaktlar, uzlaştırma, iptal, devam mesajı) ve agent işleri süreç içinde sırayla çalışır. Canlı olaylar süreç içi veriyolundadır (`createTaskEventBus`). Kalıcı olan depodur; birden fazla sunucu örneği açık noktadır (§10).

## 6. Kimlik ve güvenlik

- **Kimlik ve yetki:** Her istek gövdesi okunmadan `Authenticator` ile doğrulanır, doğrulanamazsa HTTP 401 (`-32000`) döner ve bağlantı kapanır. Çağıran (`Caller`) bir kimlik (`id`) ve adına görev açabileceği kurum adreslerini (`institutions`, `Job.institution`; Squads'a bağlı kurumda vault PDA'sı) taşır. Görev yalnızca onu açan çağırana görünür; başka çağırana, aynı kurumun başka anahtarına da `-32001` döner, görevin varlığı sızmaz.
- **API anahtarı:** `createApiKeyAuthenticator({ keys: [{ keySha256, institutions }] })` `x-api-key` başlığının SHA-256'sını izinli listeyle sabit zamanda karşılaştırır. Anahtarın kendisi sunucuda tutulmaz; çağıran kimliği `api-key:<sha256>`'dır. Her anahtar en az bir kuruma bağlıdır, kurumsuz anahtar yapılandırması reddedilir. Cüzdan imzalı istekler BE-13'te; çağıranın cüzdanı job'un kurumuyla karşılaştırılır.
- **Sürüm:** `A2A-Version` başlığı ya da sorgu parametresi `1.0` olmalıdır. Boş değer 0.3 sayılır ve `-32009` döner (spec §3.6.2). Hata ayrıntısında istenen sürüm yalnızca `MAJOR.MINOR` biçimindeyse yansıtılır.
- **Girdi:** Yalnızca `POST` (405), `content-type: application/json` (415), gövde en fazla `maxBodyBytes` (413, bağlantı kapanır), toplu istek yok (`-32600`). 128'den derin iç içe gövde ayrıştırılmadan `-32600` alır (JSON.parse derin girdiyi bellekte büyütür). Parametreler önce I-JSON'a (RFC 7493) göre denetlenir: NUL karakteri, eşleşmemiş UTF-16 surrogate, sonlu olmayan sayı (`1e999`) ve 64'ten derin iç içe değer `-32602`'dir (Postgres JSONB'si ve RFC 8785 bunları kabul etmez). Sonra zod ile doğrulanır; hatalar alan yollarıyla `google.rpc.BadRequest` olarak döner. Mesaj başına en fazla 64 parça, kimlikler en fazla 256 karakter; parça URL'leri yalnızca `https`, `http` ya da `ipfs`. `statusTimestampAfter` ve sayfa belirtecindeki zaman 1 ile 9999 yılları arasında olmalıdır; sayfa belirteci en fazla 512 karakterdir. Agent'ın durum metni ve artefaktları da depoya gitmeden I-JSON'a göre denetlenir. Bir artefakt, `append` ile birleşmiş haliyle de en fazla 64 parçadır; bir görevin artefaktları JSON olarak en fazla `maxArtifactBytes` bayttır.
- **Hata ayrıntısı:** Tel üzerindeki mesajlar spesifikasyonun standart metinleridir. Depo, zincir ve agent hataları `-32603` olarak döner, ayrıntı yalnızca `onError`'a gider. `GetTask` ve `SubscribeToTask` zincir okunamazsa kayıttaki görevi döner; iptal ve devam mesajı zincir gerektirdiği için `-32603` döner.
- **Sunucu zaman aşımları:** Paket `http.Server` kurmaz; `requestTimeout`, `headersTimeout` ve `keepAliveTimeout` sunucuyu kuran tarafındır.
- **Agent kodu:** `message.referenceTaskIds`, `metadata` ve `extensions` çağırana göre süzülmez; agent kodu başka görevleri bu kimliklerle okumamalıdır.
- **İstemci:** Varsayılan olarak yalnızca `https` uç noktası (`allowInsecureHttp` yalnızca yerel geliştirme ve testler için). Yönlendirme izlenmez (`redirect: 'error'`), yanıt ve akış olayı boyutu `maxResponseBytes` ile sınırlıdır. Akışta sunucudan veri (olay ya da kalp atışı) gelmeden `timeoutMs` geçerse bağlantı kesilir; tüketicinin olayı işleme süresi sayılmaz. İsteğin ve akışın toplam süresi her yönteme verilebilen `signal` ile sınırlanır; yalnız kalp atışı gelen bir akış da bununla durur. Akış boyut sınırı tek bir olaya uygulanır. 100 seviyeden derin yanıt ve akış olayı ayrıştırılmadan `-32006` olur. Yanıtlar zod ile doğrulanır; başarılı yanıtın kimliği istekle eşleşmelidir (yalnızca hata yanıtı `null` kimlik taşıyabilir), uymayan yanıt `-32006`'dır. Hata mesajı 1024 karaktere kısaltılır, ayrıntılardan yalnızca `@type` taşıyan nesneler alınır. Uç nokta güvenilmeyen bir agent kartından geliyorsa iç ağ ve meta veri adreslerini engelleyen bir `fetch` verilmelidir (BE-13); varsayılan `fetch` adresi denetlemez.

## 7. Kalıcı depo

`TaskStore` arayüzü depoyu soyutlar. Postgres uygulaması `createPrismaTaskStore(client)` ayrı alt yoldadır (`@squaresdk/solana-a2a/prisma`); `@squaresdk/solana-db`'ye yalnızca tip olarak bağlıdır, istemciyi çağıran verir. Tablolar `a2a_tasks` ve `a2a_messages` ([data-model.md](data-model.md) §2, zincir dışı tablolar).

- **Eşzamanlılık:** Bir görevin yazmaları süreç içinde sıralıdır. Her görev satırının `version` sütunu vardır; güncelleme beklenen sürümle yapılır ve başka bir yazıcıyla çakışmada taze okunup yeniden denenir. Depo işlemleri veritabanının varsayılanına bakmadan READ COMMITTED çalışır; serileştirme hatası (P2034) sürüm çakışması sayılır.
- **Tek etkin görev:** Görev açma READ COMMITTED bir işlemde, `(agent_record, job)` üzerine `pg_advisory_xact_lock(hashtextextended(...))` alınarak yapılır; job için terminal olmayan görev varsa açılmaz. Kısmi tekil indeks `a2a_tasks_active_job_key` aynı kuralı kilidi almayan bir yazıcıya karşı da zorlar.
- **Tekrar deneme:** `(agent_record, caller, create_message_id)` tekildir; aynı mesaj aynı görevi döner. `a2a_messages`'ta `(task_id, message_id)` tekildir; geçmiş ekleme sırasıyla (`bigserial`) döner. İstemcinin devam mesajı `pending` işaretiyle yazılır; agent onu işleyince, kuyruktayken görev terminal olunca ya da `resume()` görevi terminal bulunca işaret kalkar. Kapanış ya da çökmeyle yarım kalan mesajda kalır; işaret kalkması görev kilidi altında yazılır, aynı kimlikli tekrar işlenmiş mesajı yeniden iletmez.
- **Bütünlük:** Durum geçişi ve durum mesajının geçmişe eklenmesi tek işlemdir. Adres ve hash sütunları CHECK kısıtlarıyla zorlanır (`db/scripts/check-constraints.mjs`). Görevin bağlamı job adresi olduğundan ayrı bir `context_id` sütunu yoktur.
- **Okuma:** `ListTasks` artefaktları yalnızca istendiğinde okur; imleçli sayfalar indeksin `status_at` sınırıyla başlar.
- **Yeniden başlatma:** Görev, durumu, artefaktları ve geçmişi süreç belleğinde tutulmaz; sunucu yeniden başladığında depodan okunur (`test/two-agents.test.ts`) ve `resume()` agent işlerini ve bekleyen devam mesajlarını yeniden kurar.

## 8. Hata kodları

| Kod | Ne zaman |
|---|---|
| `-32700` | Gövde JSON değil |
| `-32600` | JSON-RPC 2.0 isteği değil, toplu istek, yanlış content-type (HTTP 415) ya da büyük gövde (HTTP 413) |
| `-32601` | Bilinmeyen yöntem |
| `-32602` | Geçersiz parametre (`BadRequest`, I-JSON dahil) ya da §4'teki Square sebepleri (`ErrorInfo`) |
| `-32603` | İç hata; ayrıntı tel üzerinde yok |
| `-32001` | Görev yok ya da çağırana ait değil |
| `-32002` | Görev iptal edilemez (§3.3) |
| `-32003` | Push bildirimleri desteklenmiyor |
| `-32004` | Terminal göreve abonelik ya da devam mesajı, devam mesajı desteklenmiyor, görevin mesaj sınırı dolu |
| `-32006` | İstemci: agent yanıtı geçersiz |
| `-32007` | Genişletilmiş agent kartı yok |
| `-32009` | Desteklenmeyen A2A sürümü |
| `-32000` | Kimlik doğrulanamadı (HTTP 401), uzun istek sınırı (HTTP 429) ya da sunucu kapanıyor (HTTP 503) |

## 9. Kaynaklardan farklar

| Kaynak | Ne oldu |
|---|---|
| aip-beta `src/lib/protocol/` @ `5a36fe0` (`a2a-client.ts`, `a2a-dispatcher.ts`, `task-machine.ts`, `messages.ts`) | Kopyalanmadı, A2A v1.0'a göre yeniden yazıldı. AIP standart dışı `task/create` ve yoklamalı `task/status` yöntemlerini kullanıyordu; yerlerini v1.0 yöntemleri ve SSE aldı. Görev makinesi kimlik doğrulama, ödeme kilidi ve istek gönderme gibi platform adımlarını görev durumu olarak tutuyordu; Square'de bu adımlar zincirdeki job'dadır ve görev durumu job'dan türetilir (§3). Bellek içi `Map` ve Supabase'e ateşle-unut yazım yerine Postgres deposu ve iyimser sürüm (§7). `a2a-dispatcher.ts`'in hosted agent ve agent memory bağları kapsam dışı |
| aip-beta `agent-card-store.ts`, `well-known-cache.ts` | Taşınmadı ([BE-02](../provenance/BE-02.md)). Bellek içi kart deposunun karşılığı `agent_cards` tablosudur (kalıcı, zincirdeki kart hash'iyle doğrulanır; yazan BE-18 `putAgentCard`); A2A katmanı kart önbelleklemez |
| covenant `app/lib/aip/a2a.ts` | Kopyalanmadı: `app/` LGPL-2.1 ve yeniden lisanslama onayı (BC-03) bekleniyor. Yalnızca davranış referansı (`task/create`, `task/status`, beş durum) |
| Square (EVM) `docs/a2a/README.md` | Referans: görev ile job'un iki ayrı durum makinesi olduğu ve A2A `COMPLETED`'ın ödeme anlamına gelmediği ilkesi §3'te korunur. Fark: Solana'da `WORKING` ve `COMPLETED`, agent'ın zincirdeki `accept_job` ve `submit_work`'üne bağlıdır |

## 10. Açık noktalar

1. **Agent kartı (BE-19, kapandı):** `AgentCardSchema`'ya A2A v1.0'ın `supportedInterfaces` alanı eklendi (sözleşme v0.18.1); dış istemciler uç noktayı bu alandan okur. `@squaresdk/solana-agent-sdk`'nın `createAgent`'ı kartı `/.well-known/agent-card.json`'da sunar ve `@a2a-js/sdk` istemcisi kartı okuyup işi gönderebilir (`packages/agent-sdk/test/agent.test.ts`).
2. **Birden fazla sunucu örneği:** Sıralı yazım ve olay veriyolu süreç içidir. Aynı agent birden fazla örnekle çalışacaksa olaylar örnekler arasında dağıtılmalı (ör. Postgres `LISTEN/NOTIFY`); depo düzeyinde iyimser sürüm ve kısmi tekil indeks bu durumda da tutarlılığı korur.
3. **Cüzdan imzalı kimlik ve hız sınırı (BE-13):** API anahtarı yerine çağıranın cüzdan imzası ve istek hız sınırı; `Authenticator` arayüzü değişmez.
4. **Uzun bekleme:** Akışsız `SendMessage` en fazla `blockingTimeoutMs` bekler; daha uzun işler için istemci `returnImmediately` ile açıp akışa abone olur.
5. **Yanıt boyutu ve sorgular:** Bir yanıttaki geçmiş `maxHistory` mesajla sınırlıdır, toplam bayt sınırı yoktur. `ListTasks` geçmiş istenirse görev başına bir geçmiş sorgusu yapar (sayfa başına en fazla 100) ve her sayfada `totalSize` için çağıranın eşleşen görevlerini sayar. `status` süzgeci için ayrı indeks yok; çağıran başına görev sayısı büyürse `(agent_record, caller, state, status_at)` eklenir.
6. **Saklama süresi:** Mesaj ve artefakt içerikleri JSONB olarak düz metin saklanır, silme ya da arşivleme kuralı yoktur.
7. **Artefakt akışı:** Artefaktlar tek bir JSONB sütunundadır; parça parça eklemede sütun her parçada yeniden yazılır. Maliyeti `maxArtifactBytes` sınırlar; büyük artefakt akışı gerekirse ayrı bir tabloya geçilir.
8. **Kilit ve zincir okuması:** Görev kilidi zincir okumasını da kapsar; yavaş bir RPC o görevin yazmalarını ve kapanışı geciktirir. Devam mesajının işlendi işareti de görev kilidi altında yazıldığından `close()` o görevde süren bir zincir okumasını bekleyebilir. web3.js `Connection`'ında zaman aşımı seçeneği yoktur; zaman aşımı bağlantıya verilen özel `fetch` ile kurulur. Aynı job için eşzamanlı görev açmaları danışma kilidini beklerken havuzdan bağlantı tutar; ani yığılma havuz beklemesini aşıp `-32603` verebilir (kural yine korunur).
9. **Yeniden iletim sınırı:** En az bir kez iletimin deneme sınırı yoktur. Hata fırlatan `onMessage` görevi FAILED yapar ve mesaj işlenmiş sayılır; yalnızca her seferinde kapanış ya da çökmeyle kesilen bir mesaj her `resume()`'da yeniden iletilir.
