#!/usr/bin/env node
// docs/did-aip/test-vectors.json'daki v1 kayıtlarını CANLI devnet'te çözer ve beklenen DID
// belgeleriyle karşılaştırır. v1 kayıtları değişebilir ya da kapanabilir; bu yüzden CI'da değil,
// elle çalıştırılır. RPC adresi zorunludur:
//   DEVNET_RPC_URL=<devnet RPC> node scripts/check-v1-devnet.mjs   (önce: pnpm build)
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { Connection } from '@solana/web3.js';
import { CHAIN_REFS, squareIdentity } from '../dist/index.js';

const rpc = process.env.DEVNET_RPC_URL;
if (!rpc) {
  console.error('DEVNET_RPC_URL gerekli');
  process.exit(2);
}
const vectors = JSON.parse(readFileSync(new URL('../../../docs/did-aip/test-vectors.json', import.meta.url), 'utf8'));
const options = {
  connections: { [CHAIN_REFS.devnet]: new Connection(rpc, 'finalized') },
  commitment: 'finalized',
  card: { maxBytes: 64 * 1024, timeoutMs: 10_000 },
  crossRegistrationLimit: 0,
};

let failed = 0;
for (const record of vectors.v1.records) {
  const result = await squareIdentity.resolveDid(record.did, options);
  const { versionId, ...metadata } = result.didDocumentMetadata;
  const ok =
    isDeepStrictEqual(result.didDocument, record.expectedDocument) &&
    isDeepStrictEqual(metadata, record.expectedMetadata);
  console.log(
    `${ok ? 'ok  ' : 'FARK'} ${record.did} (slot ${versionId ?? '-'})${result.didResolutionMetadata.error ? ` error=${result.didResolutionMetadata.error}` : ''}`,
  );
  if (!ok) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
