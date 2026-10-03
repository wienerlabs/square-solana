'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { readRole, writeRole, type Role } from '@/lib/roles';

interface RoleState {
  /** Bağlı cüzdan; yoksa rol seçilemez. */
  address: string | null;
  role: Role | null;
  setRole(role: Role): void;
}

const RoleContext = createContext<RoleState | null>(null);

export function useRole(): RoleState {
  const state = useContext(RoleContext);
  if (!state) throw new Error('useRole must be used inside <Providers>');
  return state;
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const { publicKey } = useWallet();
  const address = publicKey?.toBase58() ?? null;
  const [selection, setSelection] = useState<{ address: string; role: Role | null } | null>(null);

  // Depolama yalnızca tarayıcıda okunur; sunucu çıktısında rol yoktur.
  useEffect(() => {
    setSelection(address ? { address, role: readRole(address) } : null);
  }, [address]);

  const setRole = useCallback(
    (role: Role) => {
      if (!address) return;
      writeRole(address, role);
      setSelection({ address, role });
    },
    [address],
  );

  const value = useMemo<RoleState>(
    () => ({ address, role: selection?.address === address ? selection.role : null, setRole }),
    [address, selection, setRole],
  );
  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}
