'use client';

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { readChainTime } from './job-detail';

/**
 * Zincir saati (Unix saniye): Clock sysvar'ı dakikada bir (ve `revision` değişince) okunur, aradaki saniyeler
 * yerel saatle ilerletilir. Programlar süreleri buna göre ölçer. Ağ doğrulanmadan okunmaz; okunamazsa null.
 */
export function useChainClock(enabled: boolean, revision = 0): number | null {
  const { connection } = useConnection();
  const [chainOffset, setChainOffset] = useState<number | null>(null);
  const [localNow, setLocalNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const sync = () =>
      readChainTime(connection).then(
        (chainTime) => active && setChainOffset(chainTime - Math.floor(Date.now() / 1000)),
        () => active && setChainOffset(null),
      );
    void sync();
    const resync = setInterval(() => void sync(), 60_000);
    const tick = setInterval(() => setLocalNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => {
      active = false;
      clearInterval(resync);
      clearInterval(tick);
    };
  }, [enabled, connection, revision]);
  return chainOffset === null ? null : localNow + chainOffset;
}
