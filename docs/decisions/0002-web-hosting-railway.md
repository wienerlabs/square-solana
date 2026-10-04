# ADR 0002 — Web uygulaması da Railway'de çalışır

- **Durum:** Kabul edildi
- **Issue:** BE-37 (#133)
- **Değiştirdiği karar:** [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar) "Hosting: Vercel (web) + Railway (api ve worker'lar)"
- **Kapsam:** `apps/web` ve dağıtılan bütün servisler

## Bağlam

§12.4'te web için Vercel, API ve worker'lar (indexer, keeper, prover, screener) için Railway seçilmişti.
FE-01'in web iskeleti (#132) hazır, ama "Preview deploy çalışıyor" kriteri ayrı bir Vercel projesi ve
hesabı bekliyordu.

Web uygulaması Vercel'e özgü bir özellik kullanmıyor: ISR, edge runtime ya da görsel optimizasyonu yok.
Ağ yapılandırması derlemeye gömülmüyor, istek anında sunucuda okunuyor. Uygulama `next start` ile
sıradan bir Node servisi olarak çalışıyor ve iki platformda da kod değişikliği gerektirmiyor.

## Karar

1. **Web de Railway'de.** `apps/web` diğer servislerle aynı Railway projesinde bir servis olarak
   `next start` ile çalışır. Vercel kullanılmaz.
2. **PR preview: Railway PR Environments.** Bir PR açıldığında Railway o PR için ortam kurar; preview
   web'i aynı PR'ın preview API'siyle konuşur.
3. **Ortamlar ve gizli değişkenler tek yerde.** Devnet staging bir Railway environment'ıdır. Bütün
   servislerin env ve secret'ları Railway'de tutulur (BE-05).

## Gerekçe

- Tek platform ve tek hesap: env ve secret yönetimi, erişim ve faturalama tek yerde.
- Preview'da bütün stack aynı PR'ın koduyla çalışır. Vercel preview'ı ise ortak bir API'ye bağlanırdı.
- Uygulama platforma bağımlı değil; ileride Vercel'e dönmek dağıtım ayarı ve README değişikliğidir.

## Sonuçlar

- Her PR ortamı bütün servisleri ayağa kaldırdığı için maliyet PR başına artar. PR Environments'ın
  hangi servisleri kuracağı BE-05'te belirlenir.
- Web tek bölgede tek container olarak sunulur; global CDN yok. Gerekirse önüne Cloudflare konabilir.
- İmaj, `next start` yerine Next'in standalone sunucusunu (`server.js`) çalıştırır; bu da aynı Next.js
  Node sunucusudur. Sebep boyut: standalone çıktı yalnızca sunucunun izlediği dosyaları taşır (43 MB;
  `pnpm deploy --prod` ile 649 MB). Uygulama ayrıntısıdır, kararı değiştirmez (#132).
- FE-01'in (#21) "Preview deploy çalışıyor" kriteri Railway PR Environments ile karşılanır.
- BE-05'in (#19) iş kalemlerinde Vercel projesi yerine Railway'deki web servisi ve PR Environments
  vardır.
- Railway projesinin ve PR Environments'ın kurulumu hesap erişimi ister. `apps/web/README.md`'deki
  dağıtım bölümü ve servis yapılandırması #132'de bu karara göre güncellenir.
