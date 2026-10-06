# Runbook: keeper

**Issue:** BE-31 (#90). Keeper iki iş yapar:
- **Finalize crank'i (BE-15):** Challenge'ı biten job'ları öder.
- **CCTP relayer'ı (BE-26):** Başka zincirden gelen fonlamayı izler.

Nasıl çalıştığı: [apps/keeper](../../apps/keeper/README.md). Kararların günlüğü `keeper_actions`'tadır
(`GET /v1/keeper/actions`).

## Cüzdan

- **Ne öder:** Keeper cüzdanı işlem ücretlerini ve açtığı hesapların rent'ini öder. `ValidationRecord`, ilk
  release'te `AgentReputation`, eksikse payee'nin ve kurumun token hesabı. CCTP'de gerekirse kurumun USDC
  hesabını da açar.
- **Ne kazanır:** Keeper ücretini (`keeper_fee_bps`) kendi token hesabına alır.
- **Fonlama:** Bakiye `KEEPER_ALERT_MIN_BALANCE_LAMPORTS`'un altına inince `keeper_low_balance` çalar. Cüzdan SOL
  ile fonlanır; adres açılış logunda (`keeper`) ve `/metrics`'teki `keeper_balance_lamports`'tadır.
- **Anahtar rotasyonu:** Yeni anahtar `KEEPER_SECRET_KEY`'e yazılır ve keeper yeniden başlatılır. Eski cüzdandaki SOL
  ve keeper ücreti token'ları yeni cüzdana aktarılır. Zincirde keeper'a bağlı bir kayıt yoktur; crank izinsizdir.

## Kur

Kârlılık, SOL maliyetini `KEEPER_MINT_UNITS_PER_SOL` ile settlement mint'ine çevirir. Kur oracle'dan gelmez.
- Kur %`KEEPER_MIN_MARGIN_BPS / 100`'den fazla değiştiyse değişken güncellenir ve keeper yeniden başlatılır.
- Kur eskirse ya `unprofitable` bekletmeleri artar ya da zararına finalize yapılır.

## Alarmlar

| Alarm | Bak | Yap |
|---|---|---|
| `keeper_stalled`, `KeeperStalled` | Log'da `round_failed`; `/ready` (veritabanı, RPC) | RPC uçlarını (`KEEPER_RPC_URLS`) ve veritabanını düzelt; failover logu `rpc_failover` |
| `keeper_backlog`, `KeeperBacklog` | `GET /v1/keeper/actions?outcome=failed`, en eski job'un son kararları | Sebebe göre: `rpcError` → RPC; `programError` → log'daki program hatası; birikmiş `unprofitable` → kur ve marj |
| `keeper_errors` | Log'da `finalize_error`, `cctp_step_failed`, `round_failed`, `cctp_round_failed` | Tekrarlayan hata türünü düzelt; tek seferlik ağ hataları geri çekilmeyle kendiliğinden yeniden denenir |
| `keeper_low_balance` | `keeper_balance_lamports` | Cüzdanı fonla |
| `SLOBurnRate_keeper_finalize_*` | `keeper_finalize_delay_seconds{gate}`, birikim | Birikim yoksa gecikme ispatsızdır: `gate="proof"` işlerde kurumun ispatı geç bağlanıyor |

Bekletme sebepleri keeper'ın değil başkasının işidir:
- **`proofRequired`, `staleProof`:** Kurum release ispatını bağlamalı (`set_compliance_proof`). İspat
  indexlenince keeper beklemeden yeniden dener.
- **`screeningPending`:** Payee'nin screening kaydı temiz ya da taze değil ([screener runbook'u](screener.md)).
- **`challengeOpen`:** Ayna zincirin gerisinde; indexer'ın gecikmesine bak.

## CCTP relayer'ı

Transferlerin durumu `GET /v1/cctp/transfers` ve `cctp_transfers`'tadır; metrikler
`keeper_cctp_transitions_total`, `keeper_cctp_open_transfers{status}`. Tasarım:
[cctp-funding.md](../design/cctp-funding.md#relayer-be-26).

| Durum | Uzun süre kalırsa | Yap |
|---|---|---|
| `pendingAttestation` | Circle burn'ü görmedi ya da kesinlik bekleniyor (standart kesinlikte Ethereum'da ~15–20 dk) | `https://iris-api(-sandbox).circle.com/v2/messages/<domain>?transactionHash=<burn>`'e bak. 404 sürerse hash ya da domain yanlış kaydedilmiş: kurum doğru burn'ü yeniden kaydeder. `delayReason` hızlı burn'de yetersiz ücreti gösterir; mesaj standart kesinlikte tamamlanır |
| `attested` | Kurumun tek tx'i bekleniyor (`KEEPER_CCTP_RELAY_AFTER_SECONDS`) | Süre dolunca relayer teslim eder. `error`'da `receive_message simülasyonu` varsa log'daki program hatasına bak. Mesajın süresi (`expirationBlock`) dolduysa Circle'dan yeniden attestation istenir (`POST /v2/reattest/<nonce>`) |
| `received` | USDC kurumun hesabında, job fonlanmadı | Kurum fonlar: `POST /v1/cctp/transfers/{id}/tx` (`fund`) ya da `fund_job`. Sebep çoğunlukla screening ya da Travel Rule |
| `failed` | Son durum | `error` sebebi yazar: mesaj bu job'u fonlayamaz (başka mint alıcısı, başka hedef, teslim edeni sınırlı) ya da job fonlanmadan kapandı. USDC mint edildiyse kurumun hesabındadır |
