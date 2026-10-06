// Test fixture: servisin kullandığı Solana JSON-RPC yöntemlerini bellekteki durumla yanıtlayan yerel HTTP
// sunucusu. Servis gerçek web3.js bağlantısıyla konuşur: lookup table ve Squads hesapları `getAccountInfo`'dan,
// simülasyon sponsorun bakiyesini (ücret ve rent düşülmüş) döndürür, ücret `getFeeForMessage`'dan. Gerçek
// zincirde deneme localnet testindedir (SQUARE_LOCALNET=1).
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export interface FixtureAccount {
  owner: string;
  data: Buffer;
}

export interface Simulation {
  err: unknown;
  logs: string[];
  unitsConsumed: number;
  /** Sponsorun bu tx'te ödediği rent (lamport). */
  rent: number;
}

/** Address lookup table hesabı: 56 baytlık başlık (etkin, yetkilisiz) ve adresler. */
export function lookupTableData(addresses: readonly PublicKey[]): Buffer {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0);
  meta.writeBigUInt64LE(2n ** 64n - 1n, 4);
  return Buffer.concat([meta, ...addresses.map((address) => address.toBuffer())]);
}

export const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

export class FixtureRpc {
  slot = 5_000;
  readonly genesisHash = bs58.encode(Buffer.alloc(32, 7));
  readonly blockhash = bs58.encode(Buffer.alloc(32, 9));
  readonly accounts = new Map<string, FixtureAccount>();
  balances = new Map<string, number>();
  /** `getFeeForMessage`'ın yanıtı; null süresi dolmuş blockhash. */
  fee: number | null = 5_000;
  /** Sonraki `simulateTransaction` yanıtları (sırayla); boşsa başarılı, rent'siz simülasyon. */
  readonly simulations: Simulation[] = [];
  /** Simüle edilen ve gönderilen tx'ler (base64). */
  readonly simulated: string[] = [];
  readonly sent: string[] = [];
  /** Sonraki gönderim hatası (JSON-RPC hatası olarak); null başarılı. */
  sendError: string | null = null;
  /** Sonraki isteklere verilecek HTTP durumu; null normal yanıt. */
  failWith: number | null = null;

  reset(): void {
    this.accounts.clear();
    this.balances.clear();
    this.fee = 5_000;
    this.simulations.length = 0;
    this.simulated.length = 0;
    this.sent.length = 0;
    this.sendError = null;
    this.failWith = null;
  }

  setAccount(address: PublicKey | string, account: FixtureAccount): void {
    this.accounts.set(typeof address === 'string' ? address : address.toBase58(), account);
  }

  setLookupTable(address: PublicKey, addresses: readonly PublicKey[]): void {
    this.setAccount(address, { owner: LOOKUP_TABLE_PROGRAM, data: lookupTableData(addresses) });
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
      case 'getBalance':
        return { context, value: this.balances.get(params[0] as string) ?? 0 };
      case 'getFeeForMessage':
        return { context, value: this.fee };
      case 'simulateTransaction': {
        this.simulated.push(params[0] as string);
        const next = this.simulations.shift() ?? { err: null, logs: [], unitsConsumed: 12_345, rent: 0 };
        const config = (params[1] ?? {}) as { accounts?: { addresses: string[] } };
        const accounts = config.accounts?.addresses.map((address) => ({
          data: ['', 'base64'],
          executable: false,
          lamports: (this.balances.get(address) ?? 0) - (this.fee ?? 0) - next.rent,
          owner: '11111111111111111111111111111111',
          rentEpoch: 0,
          space: 0,
        }));
        return {
          context,
          value: {
            err: next.err,
            logs: next.logs,
            accounts: accounts ?? null,
            unitsConsumed: next.unitsConsumed,
            returnData: null,
          },
        };
      }
      case 'sendTransaction': {
        if (this.sendError !== null) {
          throw Object.assign(new Error(this.sendError), { code: -32002 });
        }
        const encoded = params[0] as string;
        this.sent.push(encoded);
        // İmza, tel biçiminin ilk imzasıdır (kısa uzunluk önekinden sonra).
        return bs58.encode(Buffer.from(encoded, 'base64').subarray(1, 65));
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
