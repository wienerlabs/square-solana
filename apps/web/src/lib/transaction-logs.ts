// İşlem loglarının toplu okunması. `getTransactions` JSON-RPC batch'idir; spec yanıtların sırasını garanti etmez ve
// RPC'ler (ör. hız sınırından sonra yeniden denemede) yanıtları farklı sırada döndürebilir. Loglar bu yüzden
// isteğin sırasına göre değil, işlemin kendi imzasına göre eşleştirilir.
import type { GetVersionedTransactionConfig, VersionedTransactionResponse } from '@solana/web3.js';

/** `Connection`'ın kullanılan yüzü. */
export interface TransactionReader {
  getTransactions(
    signatures: string[],
    config: GetVersionedTransactionConfig,
  ): Promise<(VersionedTransactionResponse | null)[]>;
}

/** İmza başına işlemin logları; işlem okunamadıysa ya da logu yoksa imza haritada yoktur. */
export async function readTransactionLogs(
  connection: TransactionReader,
  signatures: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (signatures.length === 0) return new Map();
  const transactions = await connection.getTransactions([...signatures], {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const logs = new Map<string, readonly string[]>();
  for (const transaction of transactions) {
    const signature = transaction?.transaction.signatures[0];
    const messages = transaction?.meta?.logMessages;
    if (signature && messages) logs.set(signature, messages);
  }
  return logs;
}
