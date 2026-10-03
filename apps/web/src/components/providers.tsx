'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { WalletAdapterNetwork, type WalletError } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import type { Cluster, WebConfig } from '@/lib/config';
import { NetworkGuardProvider } from './network-guard';
import { RoleProvider } from './role-provider';

import '@solana/wallet-adapter-react-ui/styles.css';

const WebConfigContext = createContext<WebConfig | null>(null);

export function useWebConfig(): WebConfig {
  const config = useContext(WebConfigContext);
  if (!config) throw new Error('useWebConfig must be used inside <Providers>');
  return config;
}

// Solflare adapter'ı ağı bilmek ister; localnet için karşılığı yoktur.
const ADAPTER_NETWORK: Record<Cluster, WalletAdapterNetwork | undefined> = {
  devnet: WalletAdapterNetwork.Devnet,
  testnet: WalletAdapterNetwork.Testnet,
  'mainnet-beta': WalletAdapterNetwork.Mainnet,
  localnet: undefined,
};

export function Providers({ config, children }: { config: WebConfig; children: ReactNode }) {
  // Phantom ve Solflare açıkça kayıtlı: cüzdanı kurulu olmayan kullanıcı modalda kurulum bağlantısını görür.
  // Wallet Standard ile kendini duyuran cüzdanlar (Backpack dahil; Phantom ve Solflare kuruluysa onlar da)
  // wallet-adapter-react tarafından otomatik eklenir ve aynı adlı adapter'ın yerini alır.
  const wallets = useMemo(() => {
    const network = ADAPTER_NETWORK[config.cluster];
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter(network ? { network } : {})];
  }, [config.cluster]);

  const onError = useCallback((error: WalletError) => {
    // eslint-disable-next-line no-console -- cüzdan hataları için tek görünür kanal
    console.error(`[wallet] ${error.name}: ${error.message}`);
  }, []);

  return (
    <WebConfigContext.Provider value={config}>
      <ConnectionProvider endpoint={config.rpcUrl} config={{ commitment: 'confirmed' }}>
        <WalletProvider wallets={wallets} onError={onError} autoConnect>
          <WalletModalProvider>
            <NetworkGuardProvider cluster={config.cluster}>
              <RoleProvider>{children}</RoleProvider>
            </NetworkGuardProvider>
          </WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </WebConfigContext.Provider>
  );
}
