// Test fixture: API'nin kullandığı Solana JSON-RPC yöntemlerini bellekteki hesaplarla yanıtlayan yerel HTTP
// sunucusu. API gerçek web3.js ve Anchor istemcisiyle konuşur (PDA çözümü hesap okur, tx simüle edilir).
// Programlarla gerçek zincirde deneme BE-36'dadır (localnet).
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bs58 from 'bs58';

export interface FixtureAccount {
  owner: string;
  data: Buffer;
}

export interface Simulation {
  err: unknown;
  logs: string[];
  unitsConsumed: number;
}

export class FixtureRpc {
  slot = 5_000;
  readonly genesisHash = bs58.encode(Buffer.alloc(32, 7));
  readonly blockhash = bs58.encode(Buffer.alloc(32, 9));
  readonly accounts = new Map<string, FixtureAccount>();
  /** Sonraki `simulateTransaction` yanıtları (sırayla); boşsa başarılı simülasyon. */
  readonly simulations: Simulation[] = [];
  /** Simüle edilen tx'ler (base64). */
  readonly simulated: string[] = [];
  /** Sonraki isteklere verilecek HTTP durumu; null normal yanıt. */
  failWith: number | null = null;

  reset(): void {
    this.accounts.clear();
    this.simulations.length = 0;
    this.simulated.length = 0;
    this.failWith = null;
  }

  setAccount(address: string, account: FixtureAccount): void {
    this.accounts.set(address, account);
  }

  private account(address: string) {
    const account = this.accounts.get(address);
    if (!account) return null;
    return {
      data: [account.data.toString('base64'), 'base64'],
      executable: false,
      lamports: 1_000_000,
      owner: account.owner,
      rentEpoch: 0,
      space: account.data.length,
    };
  }

  handle(method: string, params: unknown[]): unknown {
    const context = { slot: this.slot };
    switch (method) {
      case 'getSlot':
        return this.slot;
      case 'getGenesisHash':
        return this.genesisHash;
      case 'getLatestBlockhash':
        return { context, value: { blockhash: this.blockhash, lastValidBlockHeight: this.slot + 150 } };
      case 'getAccountInfo':
        return { context, value: this.account(params[0] as string) };
      case 'getMultipleAccounts':
        return { context, value: (params[0] as string[]).map((address) => this.account(address)) };
      case 'simulateTransaction': {
        this.simulated.push(params[0] as string);
        const next = this.simulations.shift() ?? { err: null, logs: [], unitsConsumed: 12_345 };
        return {
          context,
          value: {
            err: next.err,
            logs: next.logs,
            accounts: null,
            unitsConsumed: next.unitsConsumed,
            returnData: null,
          },
        };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }
}

export interface RpcServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startRpc(rpc: FixtureRpc): Promise<RpcServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (rpc.failWith !== null) {
        res.writeHead(rpc.failWith).end();
        return;
      }
      const call = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string; params?: unknown[] };
      let payload: unknown;
      try {
        payload = { jsonrpc: '2.0', id: call.id, result: rpc.handle(call.method, call.params ?? []) };
      } catch (error) {
        const code = (error as { code?: number }).code ?? -32603;
        payload = { jsonrpc: '2.0', id: call.id, error: { code, message: (error as Error).message } };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
