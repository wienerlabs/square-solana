'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Adapter } from '@solana/wallet-adapter-base';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { TransactionSignature, VersionedTransaction } from '@solana/web3.js';
import type { Cluster } from '@/lib/config';
import { rpcMismatch, walletMismatch } from '@/lib/network';
import { sendGuardedTransaction, type TransactionGate } from '@/lib/send-transaction';

export type RpcCheck =
  | { state: 'checking' }
  | { state: 'ready'; genesisHash: string; mismatch: string | null }
  | { state: 'error'; message: string };

export interface NetworkGuard extends TransactionGate {
  rpc: RpcCheck;
}

const NetworkGuardContext = createContext<NetworkGuard | null>(null);

export function useNetworkGuard(): NetworkGuard {
  const guard = useContext(NetworkGuardContext);
  if (!guard) throw new Error('useNetworkGuard must be used inside <Providers>');
  return guard;
}

/** Bağlı hesabın Wallet Standard zincirleri; Wallet Standard dışı adapter'da null. */
function accountChains(adapter: Adapter | undefined, address: string | undefined): readonly string[] | null {
  if (!adapter || !address || !('standard' in adapter)) return null;
  return adapter.wallet.accounts.find((account) => account.address === address)?.chains ?? null;
}

export function NetworkGuardProvider({ cluster, children }: { cluster: Cluster; children: ReactNode }) {
  const { connection } = useConnection();
  const { wallet, publicKey } = useWallet();
  const [rpc, setRpc] = useState<RpcCheck>({ state: 'checking' });

  useEffect(() => {
    let active = true;
    setRpc({ state: 'checking' });
    connection.getGenesisHash().then(
      (genesisHash) => active && setRpc({ state: 'ready', genesisHash, mismatch: rpcMismatch(cluster, genesisHash) }),
      (error: Error) => active && setRpc({ state: 'error', message: error.message }),
    );
    return () => {
      active = false;
    };
  }, [connection, cluster]);

  const adapter = wallet?.adapter;
  const address = publicKey?.toBase58();
  const guard = useMemo<NetworkGuard>(() => {
    const problems: string[] = [];
    // Ağ doğrulanamıyorsa işlem de açılmaz.
    if (rpc.state === 'error') problems.push(`The network cannot be verified because the RPC failed: ${rpc.message}`);
    if (rpc.state === 'ready' && rpc.mismatch) problems.push(rpc.mismatch);
    const walletProblem = adapter && walletMismatch(cluster, adapter.name, accountChains(adapter, address));
    if (walletProblem) problems.push(walletProblem);
    return { rpc, problems, canTransact: rpc.state === 'ready' && problems.length === 0 };
  }, [rpc, adapter, address, cluster]);

  return <NetworkGuardContext.Provider value={guard}>{children}</NetworkGuardContext.Provider>;
}

/** Bütün yazmaların geçtiği gönderim: ağ korumasından geçmeyen işlem cüzdana gitmez. */
export function useSendTransaction(): (transaction: VersionedTransaction) => Promise<TransactionSignature> {
  const guard = useNetworkGuard();
  const { connection } = useConnection();
  const { connected, signTransaction } = useWallet();
  return useCallback(
    (transaction) => sendGuardedTransaction(guard, { connected, signTransaction }, connection, transaction),
    [guard, connected, signTransaction, connection],
  );
}
