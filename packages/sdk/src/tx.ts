// Instruction'lardan imzasız v0 tx. Compute budget yalnızca istenirse eklenir (değerler çağıranın
// ya da BC-28 profillerinin; SDK varsayılan bir değer uydurmaz). ALT'ler zincirden okunur.
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Commitment,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { BuildOptions, BuiltTx } from './types.js';

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
  return {
    transaction: new VersionedTransaction(message),
    signers: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures),
    blockhash,
    lastValidBlockHeight,
  };
}
