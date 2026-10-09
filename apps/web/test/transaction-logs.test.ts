// İşlem loglarının imzaya göre eşleşmesi: JSON-RPC batch yanıtları istekle aynı sırada gelmeyebilir.
import type { VersionedTransactionResponse } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { readTransactionLogs, type TransactionReader } from '@/lib/transaction-logs';

type Fetched = (VersionedTransactionResponse | null)[];

const transaction = (signature: string, logs: string[] | null) =>
  ({
    transaction: { signatures: [signature] },
    meta: logs === null ? null : { logMessages: logs },
  }) as VersionedTransactionResponse;

const connectionReturning = (result: Fetched): TransactionReader => ({
  getTransactions: async () => result,
});

describe('transaction logs', () => {
  it('pair each signature with its own transaction even when the batch answers out of order', async () => {
    const logs = await readTransactionLogs(
      connectionReturning([
        transaction('sig-c', ['c']),
        transaction('sig-a', ['a']),
        null,
        transaction('sig-b', ['b']),
      ]),
      ['sig-a', 'sig-b', 'sig-c', 'sig-d'],
    );
    expect([...logs.entries()].sort()).toEqual([
      ['sig-a', ['a']],
      ['sig-b', ['b']],
      ['sig-c', ['c']],
    ]);
    expect(logs.has('sig-d')).toBe(false);
  });

  it('skip a transaction without logs and read nothing for no signatures', async () => {
    const logs = await readTransactionLogs(connectionReturning([transaction('sig-a', null)]), ['sig-a']);
    expect(logs.size).toBe(0);
    let called = false;
    await readTransactionLogs(
      {
        getTransactions: async () => {
          called = true;
          return [];
        },
      },
      [],
    );
    expect(called).toBe(false);
  });
});
