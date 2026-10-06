'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TravelRuleEntry } from './travel-rule';
import {
  createVaultKey,
  loadVault,
  mergeEntries,
  openVault,
  readVaultFile,
  saveVault,
  sealVault,
  type VaultFile,
  type VaultKey,
} from './travel-rule-local';

export interface TravelRuleVault {
  /** Depolama okunana kadar false. */
  loaded: boolean;
  /** Bu tarayıcıda bu cüzdanın şifreli deposu var mı. */
  exists: boolean;
  unlocked: boolean;
  /** Açık depodaki kayıtlar; kilitliyken boş. */
  entries: TravelRuleEntry[];
  /** Şifreli zarf; dışa aktarma dosyası budur. */
  file: VaultFile | null;
  /** Son yazma tarayıcı depolamasına ulaştı mı (gizli pencerede ulaşmaz). */
  stored: boolean;
  create(passphrase: string): Promise<void>;
  /** Yanlış parolada hata metni. */
  unlock(passphrase: string): Promise<string | null>;
  lock(): void;
  /** Kaydı ekleyip depoyu yeniden şifreler ve yazar; depo kilitliyse fırlatır. */
  add(entry: TravelRuleEntry): Promise<void>;
  /**
   * Dışa aktarılmış dosyayı geri yükler: depo yoksa dosya depo olur, açıksa kayıtları birleştirilir ve
   * depo kendi parolasıyla yeniden şifrelenir. Kilitli depoya yüklenmez (önce açılmalı).
   */
  restore(text: string, passphrase: string): Promise<string | null>;
}

interface State {
  owner: string;
  file: VaultFile | null;
  key: VaultKey | null;
  entries: TravelRuleEntry[];
}

/** Kurum cüzdanının Travel Rule deposu; `owner` null ise (kurum değil) boş ve kapalı. */
export function useTravelRuleVault(owner: string | null): TravelRuleVault {
  const [state, setState] = useState<State | null>(null);
  const [stored, setStored] = useState(true);
  // Zaman uyumsuz yazmalar en son durumu görsün: tx gönderilirken eklenen kayıt kaybolmasın.
  const latest = useRef<State | null>(null);
  const commit = useCallback((next: State) => {
    latest.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    if (owner === null) return;
    commit({ owner, file: loadVault(owner), key: null, entries: [] });
  }, [owner, commit]);

  const current = owner !== null && state?.owner === owner ? state : null;

  const persist = useCallback(
    async (key: VaultKey, entries: TravelRuleEntry[]) => {
      const file = await sealVault(key, entries);
      setStored(saveVault(file));
      commit({ owner: key.owner, file, key, entries });
    },
    [commit],
  );

  const create = useCallback(
    async (passphrase: string) => {
      const now = latest.current;
      if (!now || now.owner !== owner || now.file) throw new Error('A Travel Rule store already exists here.');
      await persist(await createVaultKey(now.owner, passphrase), []);
    },
    [owner, persist],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      const now = latest.current;
      if (!now?.file || now.owner !== owner) return 'There is no Travel Rule store in this browser.';
      const opened = await openVault(now.file, passphrase);
      if (!opened.ok) return opened.error;
      commit({ ...now, key: opened.key, entries: opened.entries });
      return null;
    },
    [owner, commit],
  );

  const lock = useCallback(() => {
    const now = latest.current;
    if (now) commit({ ...now, key: null, entries: [] });
  }, [commit]);

  const add = useCallback(
    async (entry: TravelRuleEntry) => {
      const now = latest.current;
      if (!now?.key || now.owner !== owner) throw new Error('Unlock the Travel Rule store first.');
      await persist(now.key, [...now.entries, entry]);
    },
    [owner, persist],
  );

  const restore = useCallback(
    async (text: string, passphrase: string) => {
      const now = latest.current;
      if (!now || now.owner !== owner) return 'The store is not loaded yet.';
      const read = readVaultFile(text, now.owner);
      if (!read.ok) return read.error;
      if (now.file && !now.key) return 'Unlock the records of this browser first; the export is merged into them.';
      const opened = await openVault(read.file, passphrase);
      if (!opened.ok) return opened.error;
      if (now.key) await persist(now.key, mergeEntries(now.entries, opened.entries));
      else {
        setStored(saveVault(read.file));
        commit({ owner: now.owner, file: read.file, key: opened.key, entries: opened.entries });
      }
      return null;
    },
    [owner, persist, commit],
  );

  return {
    loaded: current !== null,
    exists: Boolean(current?.file),
    unlocked: Boolean(current?.key),
    entries: current?.entries ?? [],
    file: current?.file ?? null,
    stored,
    create,
    unlock,
    lock,
    add,
    restore,
  };
}
