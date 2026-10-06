// Sanctions screening'in zincire yazılması (screener runbook'u, docs/runbooks/screener.md). Cüzdanlar OFAC'ın
// güncel SDN listesine karşı taranır; listede adresi geçen `Flagged`, geçmeyen `Clear` kaydedilir
// (`record_screening`, imzacı screener authority). `source_hash` listenin SHA-256'sıdır. Kaydın süresi registry
// config'indeki `screening_ttl_secs`'tir. `--dry-run` taramayı yapar, zincire yazmaz. Anahtar dosyaları repoda
// tutulmaz.
//
//   node scripts/deploy/record-screening.mjs --network devnet --screener <keypair> --payer <keypair> \
//     --wallet <adres> [--wallet <adres> …] [--dry-run]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { loadNetwork } from './network-config.mjs';
import { connectionFor } from './rpc.mjs';
import { OFAC_SDN_URL, fetchSdn, screen } from './sanctions.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const keypair = (path) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));

export function parseArgs(argv) {
  const args = { wallets: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag}: değer yok`);
    i += 1;
    if (flag === '--network') args.network = value;
    else if (flag === '--screener') args.screener = value;
    else if (flag === '--payer') args.payer = value;
    else if (flag === '--wallet') args.wallets.push(new PublicKey(value).toBase58());
    else throw new Error(`bilinmeyen argüman: ${flag}`);
  }
  if (!args.network) throw new Error('--network gerekli');
  if (args.wallets.length === 0) throw new Error('en az bir --wallet gerekli');
  if (!args.dryRun && (!args.screener || !args.payer)) throw new Error('--screener ve --payer gerekli');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = await fetchSdn();
  const result = {
    list: OFAC_SDN_URL,
    publishDate: list.publishDate,
    recordCount: list.recordCount,
    sourceHash: list.sourceHash.toString('hex'),
    ...screen(list, args.wallets),
    records: {},
  };
  if (!args.dryRun) {
    const network = loadNetwork(ROOT, args.network);
    const connection = connectionFor(network.rpc);
    const programIds = Object.fromEntries(
      Object.entries(network.programs).map(([name, id]) => [name, new PublicKey(id)]),
    );
    const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });
    const [screener, payer] = [keypair(args.screener), keypair(args.payer)];
    const config = await client.registry.fetch('registryConfig', client.pda.registryConfig()[0]);
    if (!config?.screenerAuthority.equals(screener.publicKey)) {
      throw new Error(
        `screener authority ${config?.screenerAuthority.toBase58()}, verilen anahtar ${screener.publicKey.toBase58()}`,
      );
    }
    for (const wallet of args.wallets) {
      const status = result.flagged.includes(wallet) ? { flagged: {} } : { clear: {} };
      const ix = await client.registry.instructions.recordScreening(
        [new PublicKey(wallet), status, Array.from(list.sourceHash)],
        {
          payer: payer.publicKey,
          screenerAuthority: screener.publicKey,
          config: client.pda.registryConfig()[0],
          screeningRecord: client.pda.screeningRecord(new PublicKey(wallet))[0],
        },
      );
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: blockhash,
          instructions: [ix],
        }).compileToV0Message(),
      );
      tx.sign([payer, screener]);
      const signature = await connection.sendRawTransaction(tx.serialize());
      const confirmed = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (confirmed.value.err) throw new Error(`${wallet}: ${signature} ${JSON.stringify(confirmed.value.err)}`);
      result.records[wallet] = { status: Object.keys(status)[0], signature };
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
}
