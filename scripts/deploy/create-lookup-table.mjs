// BC-30: Square address lookup table'ını (BC-28, [tx-budget.md](../../docs/design/tx-budget.md)) kurar ve
// dondurur ([runbook](../../docs/runbooks/upgrade.md) adım 5'in sonu). Adresler SDK'nın
// `squareLookupTableAddresses`'ıdır: programlar, config PDA'ları, settlement mint'i, sistem programları. Tablo
// dondurulduğu için değişmez; authority'nin elinde kalan bir yetki yoktur. Program kimliği ya da mint
// değişirse yeni tablo kurulur. Ödeyici ve geçici authority verilen keypair'dir.
//
//   node scripts/deploy/create-lookup-table.mjs --network devnet --payer <keypair>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLookupTableInstructions, createPda, squareLookupTableAddresses } from '@squaresdk/solana-sdk';
import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { loadNetwork } from './network-config.mjs';
import { connectionFor } from './rpc.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

async function send(connection, payer, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions });
  const tx = new VersionedTransaction(message.compileToV0Message());
  tx.sign([payer]);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) throw new Error(`${signature}: ${JSON.stringify(result.value.err)}`);
  return signature;
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    if (index === -1 || !argv[index + 1]) throw new Error(`${flag} gerekli`);
    return argv[index + 1];
  };
  const network = loadNetwork(ROOT, value('--network'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(value('--payer'), 'utf8'))));
  const connection = connectionFor(network.rpc);
  const programIds = Object.fromEntries(
    Object.entries(network.programs).map(([name, id]) => [name, new PublicKey(id)]),
  );
  const addresses = squareLookupTableAddresses({
    programIds,
    pda: createPda(programIds),
    settlementMint: new PublicKey(network.escrow.settlementMint),
  });
  const { lookupTable, instructions } = createLookupTableInstructions({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: await connection.getSlot('finalized'),
    addresses,
  });
  const create = await send(connection, payer, instructions);
  const freeze = await send(connection, payer, [
    AddressLookupTableProgram.freezeLookupTable({ lookupTable, authority: payer.publicKey }),
  ]);
  const table = (await connection.getAddressLookupTable(lookupTable)).value;
  if (!table) throw new Error(`${lookupTable.toBase58()} okunamadı`);
  const stored = table.state.addresses.map((key) => key.toBase58());
  if (stored.join() !== addresses.map((key) => key.toBase58()).join()) throw new Error('tablodaki adresler farklı');
  console.log(
    JSON.stringify(
      {
        lookupTable: lookupTable.toBase58(),
        frozen: table.state.authority === undefined,
        create,
        freeze,
        addresses: stored,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
