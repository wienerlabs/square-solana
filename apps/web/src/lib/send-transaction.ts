// Korumalı gönderim (FE-03). Cüzdana yalnızca imzalatılır; işlemi, ağı doğrulanmış uygulama bağlantısı
// gönderir. wallet-adapter'ın `sendTransaction`'ı Wallet Standard cüzdanlarda zinciri RPC adresinin
// metninden tahmin eder (`getChainForEndpoint`: adında "devnet" geçmeyen bir devnet RPC'si mainnet sayılır)
// ve işlemi cüzdanın kendi RPC'sine bıraktırabilir; bu yol kullanılmaz.
import type { Connection, TransactionSignature, VersionedTransaction } from '@solana/web3.js';

export class TransactionBlockedError extends Error {
  override readonly name = 'TransactionBlockedError';
}

export interface TransactionGate {
  canTransact: boolean;
  problems: readonly string[];
}

export interface TransactionSigner {
  connected: boolean;
  signTransaction?: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
}

/** Ağ korumasından geçerse işlemi imzalatıp gönderir; geçemezse cüzdana hiç gitmeden reddeder. */
export async function sendGuardedTransaction(
  gate: TransactionGate,
  signer: TransactionSigner,
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<TransactionSignature> {
  if (!gate.canTransact) {
    throw new TransactionBlockedError(
      gate.problems.length > 0 ? gate.problems.join(' ') : 'The network has not been verified yet.',
    );
  }
  if (!signer.connected) throw new TransactionBlockedError('Connect a wallet first.');
  if (!signer.signTransaction) throw new TransactionBlockedError('The connected wallet cannot sign transactions.');
  const signed = await signer.signTransaction(transaction);
  return connection.sendRawTransaction(signed.serialize(), { preflightCommitment: connection.commitment });
}
