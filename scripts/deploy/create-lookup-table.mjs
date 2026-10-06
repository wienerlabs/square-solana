// BC-30: Square address lookup table'ını (BC-28, [tx-budget.md](../../docs/design/tx-budget.md)) kurar ve
// dondurur ([runbook](../../docs/runbooks/upgrade.md) adım 5'in sonu). Adresler SDK'nın
// `squareLookupTableAddresses`'ıdır: programlar, config PDA'ları, settlement mint'i, sistem programları. Tablo
// dondurulduğu için değişmez; authority'nin elinde kalan bir yetki yoktur. Program kimliği ya da mint
// değişirse yeni tablo kurulur. Ödeyici ve geçici authority verilen keypair'dir.
//
// `--cctp <kaynak>` verilirse Square ALT'ı yerine o kaynak zincirin CCTP ALT'ı kurulur: Circle'ın Solana
// programları ve `receive_message`'ın sabit hesapları (SDK `cctpLookupTableAddresses`; BC-36). Mint ile
// fonlamanın tek tx'e sığması için iki ALT birlikte kullanılır.
//
//   node scripts/deploy/create-lookup-table.mjs --network devnet --payer <keypair> [--cctp sepolia]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cctpLookupTableAddresses,
  createLookupTableInstructions,
  createPda,
  fetchCctpFeeRecipient,
  squareLookupTableAddresses,
} from '@squaresdk/solana-sdk';
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

/** Kaynak zincirin CCTP ALT'ı: Circle'ın programları ve `receive_message`'ın sabit hesapları. */
async function cctpAddresses(connection, network, sourceName, usdcMint) {
  const source = network.cctp?.sources[sourceName];
  if (!source) throw new Error(`${network.cluster} yapılandırmasında ${sourceName} CCTP kaynağı yok`);
  const programs = {
    messageTransmitter: new PublicKey(network.cctp.messageTransmitter),
    tokenMessengerMinter: new PublicKey(network.cctp.tokenMessengerMinter),
  };
  const mint = await connection.getAccountInfo(usdcMint);
  if (!mint) throw new Error(`settlement mint'i yok: ${usdcMint.toBase58()}`);
  return cctpLookupTableAddresses({
    programs,
    usdcMint,
    sourceDomain: source.domain,
    burnToken: Buffer.concat([Buffer.alloc(12), Buffer.from(source.usdc.slice(2), 'hex')]),
    feeRecipient: await fetchCctpFeeRecipient(connection, programs),
    tokenProgram: mint.owner,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const value = (flag, required = true) => {
    const index = argv.indexOf(flag);
    if (index === -1 || !argv[index + 1]) {
      if (required) throw new Error(`${flag} gerekli`);
      return null;
    }
    return argv[index + 1];
  };
  const network = loadNetwork(ROOT, value('--network'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(value('--payer'), 'utf8'))));
  const connection = connectionFor(network.rpc);
  const programIds = Object.fromEntries(
    Object.entries(network.programs).map(([name, id]) => [name, new PublicKey(id)]),
  );
  const settlementMint = new PublicKey(network.escrow.settlementMint);
  const cctpSource = value('--cctp', false);
  const addresses = cctpSource
    ? await cctpAddresses(connection, network, cctpSource, settlementMint)
    : squareLookupTableAddresses({ programIds, pda: createPda(programIds), settlementMint });
  const { lookupTable, instructions } = createLookupTableInstructions({
    authority: payer.publicKey,
    payer: payer.publicKey,
    // Tablo adresi bu slottan türer; slot SlotHashes'te (son ~512 slot) olmalı: gönderimden hemen önce okunur.
    recentSlot: await connection.getSlot('confirmed'),
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
