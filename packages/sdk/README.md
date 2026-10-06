# @squaresdk/solana-sdk

Square'in TypeScript SDK'sı (BE-08):
- **Zincir:** Dört program için typed istemci, PDA'lar, 8 adımın tx builder'ları, event çözücü, hata eşleme.
- **İşlem profili:** Compute sınırları ve Square ALT'ı (BC-28).
- **HTTP:** REST API istemcisi (BE-18).
- **CCTP:** CCTP ile fonlama (BC-36, BE-26).

Sözleşmesi [api-sdk-contract.md](../../docs/design/api-sdk-contract.md), protokol özeti
[protocol.md](../../docs/protocol.md)'dir. Her dışa aktarımın açıklaması referanstadır (`pnpm docs:build`).

## İstemci

```ts
import { createSquareClient } from '@squaresdk/solana-sdk';
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection(rpcUrl, 'confirmed');
// Program kimlikleri ağın yapılandırmasından gelir (deploy kaydı); SDK sabit adres taşımaz.
const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });

const job = await client.escrow.fetch('job', jobAddress); // yoksa null
const [vault] = client.pda.vault(jobAddress);
```

## 8 adım

`client.flow` her adımın imzasız v0 tx'ini kurar (`BuiltTx`):
- **Hesaplar:** PDA'ları, payee'yi, screening ve ispat hesaplarını zincirden kendisi çözer.
- **Compute:** Sınırı tx türünün profilinden ekler.
- **İmza:** Tx'i rol cüzdanı imzalar (wallet-adapter ya da Keypair). `feePayer` rol imzacısından ayrı olabilir
  (sponsor).

```ts
const created = await client.flow.createJob(
  { institution, agentRecord, spec, amount: 25_000_000n, deadline, challengePeriod },
  { feePayer: institution, addressLookupTables: [squareLookupTable] },
);
created.transaction.sign([institutionKeypair]);
await connection.sendRawTransaction(created.transaction.serialize());
```

| Adım | Akış |
|---|---|
| Agent kaydı | `registerAgent` |
| Job ve fonlama | `createJob`, `commitTravelRule`, `fundJob`; başka zincirden `receiveAndFundJob` (CCTP) |
| Kabul ve teslim | `acceptJob`, `submitWork` (`workHash` teslim baytlarının SHA-256'sı) |
| Alacak piyasası | `listClaim`, `buyClaim`, `cancelClaim` |
| Ödeme | `finalizePayment` (keeper) |
| Dispute | `raiseDispute`, `resolveDispute`, `executeResolution` |
| İptal | `cancelJob` |

Politikalı işin ispatı `@squaresdk/solana-policy`'dedir (`buildSetComplianceProofTx`).

## Event'ler ve hatalar

- **Event'ler:** `client.decodeEvents(logs, { signature, slot })` tx loglarındaki event'leri çözer.
  `decodeTransactionEvents` aynısını tx içindeki konumla yapar (indexer).
- **Hatalar:** `client.mapError(error)` simülasyon ya da gönderim hatasını program, kod ve ada eşler.

## HTTP API

```ts
import { createApiClient } from '@squaresdk/solana-sdk';

const api = createApiClient({ baseUrl, auth: { apiKey } });
const jobs = await api.listJobs({ status: 'funded', agentRecord });
if (jobs.success) console.log(jobs.data, jobs.meta.total);
```

Metotlar OpenAPI'nin `operationId`'leridir (`API_OPERATIONS`). `/v1` yanıtları `{ success, data, error, meta }`
zarfıyla döner.

## CCTP

- **Kaynak zincir:** `cctpBurnCall` ve `cctpApproveCall`, viem / wagmi `writeContract` biçiminde çağrı tarifi döner.
- **Attestation:** `fetchCctpAttestation` Circle'ın servisine tek bakıştır.
- **Solana:** `flow.receiveAndFundJob` mint ile `fund_job`'u tek tx'te kurar.
- **Tasarım:** [cctp-funding.md](../../docs/design/cctp-funding.md).

## Testler

`pnpm --filter @squaresdk/solana-sdk test`. Sözleşmeyle hiza `test/contract.test.mjs`'tedir: OpenAPI operasyonları,
IDL kopyaları ve dışa aktarım yüzeyi.
