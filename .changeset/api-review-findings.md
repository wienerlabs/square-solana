---
'@squaresdk/solana-api': minor
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': patch
'@squaresdk/solana-db': minor
'@squaresdk/solana-web': patch
---

Bağımsız incelemenin API bulguları (API sözleşmesi v0.25.0).

`@squaresdk/solana-api`: gizli dispute kanıtı (liste, içerik) ve arbitrator kuyruğu anahtarla gelen istekte `read` yerine
`disputes:read` ister; `read` anahtarı bu verilere artık erişemez. `recordX402Payment`'ın tekilliği tanım sahibinin
cüzdanı başınadır; başka bir cüzdan aynı ödemeyi önce bildirerek sahibinin kaydını engelleyemez. Kuyruk kanıtları
taraf rolü çözmeden okur; Squads vault'lu bir kurumun multisig'i okunamasa da açılır. Kanıtın taraf denetiminde
multisig okunamazsa agent ve arbitrator yine kendi rolleriyle okur ve yükler. Bildirim kiralaması satır alınırken
başlar ve yalnızca satırın okunduğu andaki deneme sayısı ve sırası tutuyorsa alınır; başka örneğin ilerlettiği satır
eski kopyayla yeniden gönderilmez. `API_ARBITRATOR_CACHE_SECONDS` en çok 300; `API_NOTIFY_ALLOW_INSECURE` yalnızca yerel geliştirme
adresinde açılır.

`@squaresdk/solana-types`: `ApiKeyScope`'a `disputes:read`; `API_CONTRACT_VERSION` 0.25.0.

`@squaresdk/solana-db`: migration `20261007090000_api_review_findings`: `x402_payments.wallet` (mevcut satırlar tanım
sahibinden doldurulur), cüzdan başına tekil ödeme indeksleri, `disputes` sayaç sütunlarının varsayılanı 0 (eski
indexer'la sıralı dağıtımda ekleme düşmez), cüzdanı vermeyen önceki API sürümünün ödeme yazımını tanım sahibinden
tamamlayan trigger, `ApiKeyScope` değeri `disputes:read`.

`@squaresdk/solana-web`: geliştirici portalında `disputes:read` kapsamının açıklaması.
