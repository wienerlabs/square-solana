# ADR 0027: Square yalnızca devnet'te çalışır; mainnet ortamı yok

- **Durum:** Kabul edildi
- **Issue:** BE-34 (#99), BC-42 (#98)
- **Karar kaynağı:** Proje sahibinin kararı (2026-10-07): "mainnet deploy olmayacak, sistem tamamen devnet'te
  çalışacak".
- **Değiştirdiği karar:**
  - [Analiz](../analysis/square-solana-analysis.md) M9'un mainnet hedefi ("Audit ve mainnet");
  - [ortamlar](../environments.md) belgesindeki Production (mainnet) ortamı.
- **Kapsam:** Dağıtım, ortamlar, issue'lar ve operasyon belgeleri. Programlar ve paketler değişmez.

## Bağlam

- Programlar, servisler ve web devnet'te çalışıyor ([deploy kaydı](../deploy/devnet.md)).
- Planda mainnet için iki issue vardı:
  - **BC-42 (#98):** mainnet deploy; programlar, Squads upgrade authority, init. Dış audit (BC-41) ve kamusal
    tören (BC-38) sonrası.
  - **BE-34 (#99):** servislerin ve web'in mainnet ortamı.
- Ortamlar belgesi ve bazı belgeler mainnet'i gelecekteki ortam olarak anıyordu:
  - SLO;
  - upgrade runbook'u;
  - deploy kaydı;
  - prover ve devre README'leri;
  - izleme.
- **Kodda ağdan bağımsız destek var.** Kaynakları:
  - x402 v2'nin CAIP-2 ağları;
  - did:aip v2'nin Solana ağ referansı;
  - CLI'nin, web'in ve smoke'un küme seçenekleri (`mainnet-beta`);
  - explorer bağlantıları.

  Bunlar Solana'nın ve standartların tanımlayıcılarıdır. Yayımlanan paketlerin (`@squaresdk/solana-*`) kullanıcıları
  da bunlara dayanır.

## Karar

1. Square'in dağıtıldığı tek ağ devnet'tir; geliştirme ve testler localnet'te de çalışır. Mainnet ortamı, mainnet
   program deploy'u ve mainnet config'i yoktur.
2. Ortamlar:
   - PR preview ve devnet ortamı (Railway `staging`) kalır;
   - Production (mainnet) satırı kaldırılır;
   - Devnet ortamı Square'in kalıcı ortamıdır.
3. BE-34 ve BC-42 kapsam dışı kalır ve "not planned" olarak kapatılır. Bağımlılıkları açık başka bir issue'yu
   bekletmez: BE-34'ü ve BC-42'yi bekleyen issue yok.
4. Ağdan bağımsız kod korunur:
   - CAIP-2 ağları;
   - did:aip ağ referansı;
   - küme seçenekleri ve explorer bağlantıları.

   Square'in yapılandırmaları devnet'i seçer.
5. Mainnet'i "sonraki ortam" olarak anan belgeler devnet'e göre düzeltilir. Kabul edilmiş ADR'lerin kararı
   değişmez; ADR kurallarının izin verdiği sonuç ve açık nokta satırları güncellenir:
   - [ADR 0008](0008-upgrade-authority-2-of-3-squads.md): mainnet multisig'i ve authority devri;
   - [ADR 0012](0012-ispat-tazeligi-ve-gunluk-sayac.md): toleransın mainnet değeri.

   [ADR 0018](0018-x402-facilitator.md)'in mainnet satırları x402 ağ desteğidir (madde 4), değişmez.
6. Kamusal phase-2 töreni (BC-38) ile dış audit issue'ları (BC-40, BC-41) bu karardan etkilenmez. Tören devnet
   verifier'ının anahtarını değiştirir. Audit'in mainnet'e bağlı gerekçesi kalkar; issue'ların kapsamı sahiplerinin
   kararıdır.

## Gerekçe

Kaynak, kararın gerekçesini vermiyor; yalnızca kararı bildiriyor.

Madde 4'ün gerekçesi bu ADR'nindir: o değerler ağ protokolünün ve standartların tanımlayıcılarıdır. Silinmeleri
şunları bozar:

- did:aip test vektörleri;
- x402 ağ eşlemesi;
- yayımlanan paketlerin genel kullanımı.

Devnet'te çalışmaya bir katkıları da olmaz.

## Sonuçlar

- **Kapatılan issue'lar:** BE-34 (#99) ve BC-42 (#98), "not planned".
- **Güncellenen belgeler:**
  - ADR 0008 ve ADR 0012'nin sonuç ve açık nokta satırları;
  - [environments.md](../environments.md) (üreteci `scripts/ci/env-inventory.mjs`);
  - [slo.md](../slo.md);
  - [upgrade runbook'u](../runbooks/upgrade.md);
  - [deploy kaydı](../deploy/devnet.md);
  - `infra/monitoring/README.md`;
  - `apps/prover/README.md`;
  - `circuits/payment-compliance/README.md`.
- **Programlar ve paketler değişmez:** Program ID'leri, IDL'ler, paket API'leri ve küme seçenekleri aynı kalır.
