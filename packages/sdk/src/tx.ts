// Instruction'lardan imzasız v0 tx. Compute budget yalnızca seçeneklerde varsa eklenir: akışlar
// profilin sınırını verir (budget.ts, BC-28), fiyatı çağıran seçer. ALT'ler zincirden okunur. Pakete
// sığmayan tx kurulurken reddedilir.
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Commitment,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { PACKET_DATA_SIZE } from './budget.js';
import type { BuildOptions, BuiltTx } from './types.js';

/** İmzalı tx'in tel boyutu (imzasız tx'te imza yerleri sıfırdır); mesaj paketi aşıyorsa sonsuz. */
function wireSize(transaction: VersionedTransaction): number {
  try {
    return transaction.serialize().length;
  } catch (error) {
    // web3.js mesajı paket boyutunda bir tampona yazar; aşan mesaj RangeError verir.
    if (error instanceof RangeError) return Number.POSITIVE_INFINITY;
    throw error;
  }
}

async function lookupTables(connection: Connection, keys: BuildOptions['addressLookupTables']) {
  return Promise.all(
    (keys ?? []).map(async (key): Promise<AddressLookupTableAccount> => {
      const { value } = await connection.getAddressLookupTable(key);
      if (!value) throw new Error(`address lookup table bulunamadı: ${key.toBase58()}`);
      return value;
    }),
  );
}

export async function buildVersionedTx(
  connection: Connection,
  commitment: Commitment,
  instructions: readonly TransactionInstruction[],
  options: BuildOptions,
): Promise<BuiltTx> {
  const budget: TransactionInstruction[] = [];
  if (options.computeUnitLimit !== undefined) {
    budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnitLimit }));
  }
  if (options.computeUnitPrice !== undefined) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: options.computeUnitPrice }));
  }
  const [tables, { blockhash, lastValidBlockHeight }] = await Promise.all([
    lookupTables(connection, options.addressLookupTables),
    connection.getLatestBlockhash(commitment),
  ]);
  const message = new TransactionMessage({
    payerKey: options.feePayer,
    recentBlockhash: blockhash,
    instructions: [...budget, ...instructions],
  }).compileToV0Message(tables);
  const transaction = new VersionedTransaction(message);
  if (wireSize(transaction) > PACKET_DATA_SIZE) {
    throw new Error(
      `tx paket sınırını (${PACKET_DATA_SIZE} bayt) aşıyor: Square address lookup table'ını ` +
        '`addressLookupTables` ile verin (squareLookupTableAddresses)',
    );
  }
  return {
    transaction,
    signers: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures),
    blockhash,
    lastValidBlockHeight,
  };
}
