# ADR 0022: Hosted agent çalışma zamanı izolasyonu: süreç içi, capability başına bağlam

- **Durum:** Kabul edildi
- **Issue:** BE-29 (#88)
- **Karar kaynağı:** BE-29 iş kalemi 4 ("Çalışma zamanı izolasyonu") ve Square (Arc) kapsamı,
  [analiz §4.2](../analysis/square-solana-analysis.md) "hosted agent (konfigürasyondan çalışan kurum agent'ı, politika
  altında delegasyon)" (2026-10-06)
- **Kapsam:** [`packages/hosted`](../../packages/hosted/) (`@squaresdk/solana-hosted`, `square-hosted`)

## Bağlam

Hosted agent'ta her capability bir Claude çalıştırmasıdır (Messages API ile tool döngüsü) ve yalnızca yapılandırmada
izin verilen MCP tool'larını görür. Bir capability'nin hatası, yavaşlığı ya da aşırı kullanımı diğer capability'leri
ve agent'ın A2A uç noktasını durdurmamalıdır. Bir çalıştırmanın yaptığı işler:

- Claude API'sine HTTP istekleri (G/Ç);
- MCP tool çağrıları (G/Ç). Stdio sunucuları zaten ayrı alt süreçtir; HTTP sunucuları uzaktadır;
- delegasyon tool'u: politika kapısı ve imzalı tx'ler (G/Ç, kurumun anahtarı süreçte).

Çalıştırmada Claude'un ürettiği kod yürütülmez. CPU yoğun iş de yoktur. Yapılandırma ise güvenilen operatör
girdisidir, kod gibi davranır: stdio MCP sunucusunun komutu, argümanları ve ortamı serbesttir; alt süreç hosted
agent'ın işletim sistemi kullanıcısıyla çalışır ve agent'ın okuyabildiği her dosyayı (keypair dosyaları dahil)
okuyabilir. Yapılandırmayı yazan, agent'ın anahtarlarına erişimi olan kişidir.

## Değerlendirilen seçenekler

1. **Süreç içi, capability başına bağlam.** Capability'nin kendi MCP havuzu (yalnızca allowlist'teki sunucular), tool
   allowlist'i, zaman / istek / token sınırları, eşzamanlılık sınırı ve sınırlı kuyruğu vardır; istisnalar o görevde
   kalır.
   - Artısı: Ek süreç yönetimi ya da mesajlaşma yoktur. A2A görevi, iptal sinyali ve agent-sdk'nın teslim akışı
     doğrudan kullanılır. Tool'ların kendisi zaten süreç dışındadır.
   - Eksisi: Bellek ve olay döngüsü ortaktır. Senkron bir sonsuz döngü bütün süreci durdurur; ancak böyle bir kod
     çalıştırılmaz.
2. **`worker_threads`.** Capability başına bir worker.
   - Artısı: Ayrı V8 heap ve `resourceLimits` ile bellek sınırı.
   - Eksisi: Claude istemcisi, MCP havuzu ve delegator worker'a taşınmalı ya da mesajla vekâlet edilmeli. Kurumun
     anahtarı ya her worker'a kopyalanır ya da imza için ana iş parçacığına dönülür. G/Ç bağımlı iş için kazanç
     yoktur.
3. **Capability başına alt süreç.**
   - Artısı: En güçlü yalıtım: işletim sistemi sınırları, ayrı kullanıcı.
   - Eksisi: Süreç denetimi, yeniden başlatma ve IPC gerekir. Anahtar ve görev deposu bağlantısı her süreçte
     çoğalır. Çalıştırılan güvenilmeyen kod olmadığından gerekçesi zayıftır.

## Karar

1. İzolasyon süreç içidir. Her capability'nin bir `CapabilityRuntime`'ı vardır
   ([`src/runtime.ts`](../../packages/hosted/src/runtime.ts)).
2. Her capability'nin ayrı bir `McpClientPool`'u vardır ve havuzda yalnızca allowlist'inin sunucuları bulunur.
   Bağlantılar, sunucu başına eşzamanlılık ve tool önbelleği capability'ler arasında paylaşılmaz.
3. Tool allowlist'i iki yerde uygulanır: liste dışındaki tool Claude'a gösterilmez; Claude yine de adını yazarsa
   çağrı sunucuya gitmeden `is_error` sonucuyla döner ve sayılır.
4. Her çalıştırmanın sınırları yapılandırmada zorunludur: `timeoutMs` (çalıştırmanın bütün süresi, `AbortSignal`
   ile tool çağrılarına da iner), `maxTurns`, `maxTokens` (yanıt başına), `maxTotalTokens` (bütün istekler),
   `maxConcurrency`, `maxQueue` ve `maxToolResultBytes`.
5. Hata yalıtımı: çalıştırmanın istisnası yalnızca kendi A2A görevini `FAILED` yapar. Diğer capability'ler, A2A
   sunucusu ve duty'ler sürer. Eşzamanlılık ve kuyruk sınırı `accept_job`'dan önce denetlenir (agent-sdk `admit`):
   yer yoksa görev reddedilir; kabul edilmiş iş yer bekler ve düşmez. Bekleyen iş iptal edilirse slot almadan çıkar.
6. Kurumun anahtarı tek süreçtedir ve yalnızca delegator ile duty'ler kullanır. Claude'un girdisi delegasyon
   politikasını aşamaz; kapı Claude'dan bağımsızdır.
7. Yapılandırma şeması imzanın delegasyon kapısı dışına çıkmasını engelleyen yanlış yapılandırmaları reddeder: stdio
   MCP sunucusunun ortamında `SQUARE_SIGNER_KEYPAIR` (Square MCP'nin yerel imzalayıcısı) olamaz, argümanlarında
   agent ya da kurum keypair dosyası geçemez. Bu bir yanlış yapılandırma korumasıdır, kötü niyetli yapılandırmaya
   karşı yalıtım değildir (Bağlam).

## Gerekçe

Kaynak (analiz §4.2 ve issue) izolasyonun biçimini belirtmez; issue "gerekirse worker_threads ya da alt süreç" der.
Seçim yukarıdaki değerlendirmeye dayanır. Çalıştırmalar G/Ç bağımlıdır ve güvenilmeyen kod yürütmez. Tool'lar zaten
ayrı süreçte ya da uzaktadır. Kaynak, zaman, token ve eşzamanlılık sınırları süreç içinde uygulanabilir. Worker ya da
alt süreç, kurumun anahtarını çoğaltır ya da imza için IPC ekler; bunun karşılığında yalnızca bellek sınırı kazanılır.

## Sonuçlar

- Uygulama: [`packages/hosted/src/runtime.ts`](../../packages/hosted/src/runtime.ts),
  [`claude.ts`](../../packages/hosted/src/claude.ts), [`tools.ts`](../../packages/hosted/src/tools.ts),
  [`hosted.ts`](../../packages/hosted/src/hosted.ts). Testler: `test/runtime.test.ts` (zaman sınırı, eşzamanlılık
  ve kuyruk, iptal, kapatma, bir capability çökerken diğerinin sürmesi) ve `test/claude.test.ts` (allowlist, tur ve
  token sınırları) (2026-10-06).
- Capability başına bellek sınırı yoktur. Bellek sınırı süreç düzeyindedir (konteyner). Bir capability'nin bellek
  tüketimi diğerlerini etkileyebilir.
- Güvenilmeyen kod çalıştıran bir capability türü eklenirse (ör. kod yürütme tool'u süreç içinde) bu karar yeniden
  değerlendirilir ve alt süreç ya da worker seçeneği yeni bir ADR olur.

## Açık noktalar

- Süreç düzeyi bellek ve CPU sınırları dağıtımın (Railway servis tanımı) işidir. Hosted agent'ın servis olarak
  dağıtımı bu ADR'nin kapsamında değildir.
- Stdio MCP sunucularının ayrıcalık yalıtımı (ayrı işletim sistemi kullanıcısı ya da konteyner, keypair dosyalarına
  erişimsiz) dağıtımın işidir; yapılandırmayı güvenilmeyen birinin yazacağı bir kurulum için önkoşuldur.
