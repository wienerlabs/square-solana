// Test fixture: indexer'ın kullandığı Solana JSON-RPC yöntemlerini bellekteki hesap ve tx'lerle yanıtlayan
// yerel HTTP sunucusu. Indexer gerçek web3.js istemcisiyle konuşur; yanıtlar RPC'nin JSON biçimindedir.
// Programlar gerçek zincirde BE-36'da (localnet) denenir; burada hesaplar ve event logları IDL coder'ıyla
// kodlanır.
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bs58 from 'bs58';

export interface FixtureAccount {
  owner: string;
  data: Buffer;
  lamports: number;
}

export interface FixtureKey {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}

export interface FixtureTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  logs: string[];
  /** Mesajdaki statik hesaplar; imzacılar önce, sonra yazılabilir, sonra salt okunur. */
  keys: FixtureKey[];
  /** v0 tx'in lookup table'dan yüklenen hesapları. */
  loaded: { table: string; writable: string[]; readonly: string[] } | null;
  /** `confirmed` durumdaki tx `finalized` okumalarda görünmez. */
  finalized: boolean;
}

export class FixtureChain {
  slot = 1_000;
  readonly accounts = new Map<string, FixtureAccount>();
  readonly txs: FixtureTx[] = [];
  /** Bu imzaların tx'i `getTransaction`'da henüz okunamaz (RPC düğümü geride). */
  readonly unavailable = new Set<string>();
  /** Çağrılan yöntemler (test denetimi için). */
  readonly calls: string[] = [];

  /** Boş zincir (testler arası). */
  reset(): void {
    this.slot = 1_000;
    this.accounts.clear();
    this.txs.length = 0;
    this.unavailable.clear();
    this.calls.length = 0;
  }

  setAccount(address: string, account: FixtureAccount): void {
    this.accounts.set(address, account);
  }

  deleteAccount(address: string): void {
    this.accounts.delete(address);
  }

  addTx(tx: FixtureTx): void {
    this.txs.push(tx);
    this.slot = Math.max(this.slot, tx.slot + 1);
  }

  private mentions(tx: FixtureTx, address: string): boolean {
    return (
      tx.keys.some((key) => key.pubkey === address) ||
      (tx.loaded !== null && [...tx.loaded.writable, ...tx.loaded.readonly].includes(address))
    );
  }

  /** `getSignaturesForAddress`: yeniden eskiye. */
  signaturesFor(address: string, options: { limit?: number; before?: string; until?: string }) {
    const ordered = this.txs
      .map((tx, index) => ({ tx, index }))
      .filter(({ tx }) => tx.finalized && this.mentions(tx, address))
      .sort((a, b) => b.tx.slot - a.tx.slot || b.index - a.index)
      .map(({ tx }) => tx);
    let start = 0;
    if (options.before) start = ordered.findIndex((tx) => tx.signature === options.before) + 1;
    const out = [];
    for (const tx of ordered.slice(start)) {
      if (tx.signature === options.until) break;
      out.push(tx);
      if (out.length === (options.limit ?? 1000)) break;
    }
    return out.map((tx) => ({
      signature: tx.signature,
      slot: tx.slot,
      err: tx.err,
      memo: null,
      blockTime: tx.blockTime,
      confirmationStatus: 'finalized',
    }));
  }

  transactionJson(signature: string) {
    const tx = this.txs.find((candidate) => candidate.signature === signature);
    if (!tx || !tx.finalized || this.unavailable.has(signature)) return null;
    const signers = tx.keys.filter((key) => key.signer);
    const readonlySigned = signers.filter((key) => !key.writable).length;
    const readonlyUnsigned = tx.keys.filter((key) => !key.signer && !key.writable).length;
    const total = tx.keys.length + (tx.loaded ? tx.loaded.writable.length + tx.loaded.readonly.length : 0);
    const message = {
      accountKeys: tx.keys.map((key) => key.pubkey),
      header: {
        numRequiredSignatures: signers.length,
        numReadonlySignedAccounts: readonlySigned,
        numReadonlyUnsignedAccounts: readonlyUnsigned,
      },
      // Programın kendisi son statik hesap; talimat verisi indexer için önemsiz.
      instructions: [{ programIdIndex: tx.keys.length - 1, accounts: [], data: '' }],
      recentBlockhash: bs58.encode(Buffer.alloc(32, 9)),
      ...(tx.loaded
        ? {
            addressTableLookups: [
              {
                accountKey: tx.loaded.table,
                writableIndexes: tx.loaded.writable.map((_, i) => i),
                readonlyIndexes: tx.loaded.readonly.map((_, i) => tx.loaded!.writable.length + i),
              },
            ],
          }
        : {}),
    };
    return {
      slot: tx.slot,
      blockTime: tx.blockTime,
      version: tx.loaded ? 0 : 'legacy',
      meta: {
        err: tx.err,
        status: tx.err === null ? { Ok: null } : { Err: tx.err },
        fee: 5000,
        preBalances: Array.from({ length: total }, () => 0),
        postBalances: Array.from({ length: total }, () => 0),
        innerInstructions: [],
        logMessages: tx.logs,
        preTokenBalances: [],
        postTokenBalances: [],
        rewards: [],
        loadedAddresses: { writable: tx.loaded?.writable ?? [], readonly: tx.loaded?.readonly ?? [] },
        computeUnitsConsumed: 1_000,
      },
      transaction: { signatures: [tx.signature], message },
    };
  }

  accountJson(address: string) {
    const account = this.accounts.get(address);
    if (!account) return null;
    return {
      data: [account.data.toString('base64'), 'base64'],
      executable: false,
      lamports: account.lamports,
      owner: account.owner,
      rentEpoch: 0,
      space: account.data.length,
    };
  }
}

interface MemcmpFilter {
  memcmp?: { offset: number; bytes: string };
  dataSize?: number;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function handle(chain: FixtureChain, method: string, params: unknown[]): unknown {
  chain.calls.push(method);
  const context = { slot: chain.slot };
  switch (method) {
    case 'getSlot':
      return chain.slot;
    case 'getSignaturesForAddress':
      return chain.signaturesFor(params[0] as string, (params[1] ?? {}) as Record<string, string | number>);
    case 'getTransaction':
      return chain.transactionJson(params[0] as string);
    case 'getMultipleAccounts': {
      const config = (params[1] ?? {}) as { minContextSlot?: number };
      if (config.minContextSlot !== undefined && config.minContextSlot > chain.slot) {
        throw new RpcError(-32016, 'Minimum context slot has not been reached');
      }
      return { context, value: (params[0] as string[]).map((address) => chain.accountJson(address)) };
    }
    case 'getProgramAccounts': {
      const config = (params[1] ?? {}) as { filters?: MemcmpFilter[] };
      const value = [...chain.accounts]
        .filter(([, account]) => account.owner === params[0])
        .filter(([, account]) =>
          (config.filters ?? []).every((filter) => {
            if (filter.dataSize !== undefined) return account.data.length === filter.dataSize;
            const bytes = Buffer.from(bs58.decode(filter.memcmp!.bytes));
            return account.data.subarray(filter.memcmp!.offset, filter.memcmp!.offset + bytes.length).equals(bytes);
          }),
        )
        .map(([pubkey]) => ({ pubkey, account: chain.accountJson(pubkey) }));
      return { context, value };
    }
    case 'getSignatureStatuses': {
      const value = (params[0] as string[]).map((signature) => {
        const tx = chain.txs.find((candidate) => candidate.signature === signature);
        if (!tx) return null;
        return {
          slot: tx.slot,
          confirmations: tx.finalized ? null : 1,
          err: tx.err,
          status: tx.err === null ? { Ok: null } : { Err: tx.err },
          confirmationStatus: tx.finalized ? 'finalized' : 'confirmed',
        };
      });
      return { context, value };
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

export interface RpcServer {
  readonly url: string;
  /** Sonraki isteklere verilecek HTTP durumu (failover testi); null normal yanıt. */
  failWith: number | null;
  close(): Promise<void>;
}

export async function startRpcServer(chain: FixtureChain): Promise<RpcServer> {
  const state: { failWith: number | null } = { failWith: null };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (state.failWith !== null) {
        res.writeHead(state.failWith).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as
        { id: unknown; method: string; params?: unknown[] } | { id: unknown; method: string; params?: unknown[] }[];
      const answer = (call: { id: unknown; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: call.id, result: handle(chain, call.method, call.params ?? []) };
        } catch (error) {
          const code = error instanceof RpcError ? error.code : -32603;
          return { jsonrpc: '2.0', id: call.id, error: { code, message: (error as Error).message } };
        }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get failWith() {
      return state.failWith;
    },
    set failWith(value) {
      state.failWith = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
