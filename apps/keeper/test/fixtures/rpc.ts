// Test fixture: keeper'ın kullandığı Solana JSON-RPC yöntemlerini bellekteki hesaplarla yanıtlayan yerel HTTP
// sunucusu. Keeper gerçek web3.js ve Anchor istemcisiyle konuşur; gönderilen tx'ler kaydedilir, onay durumu
// test tarafından verilir. Programlarla gerçek finalize BE-36'dadır (localnet).
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export interface Simulation {
  err: unknown;
  logs: string[];
}

/** Rent muafiyeti: yıllık bayt başına 3480 lamport × 2 yıl × (boyut + 128 bayt hesap başlığı). */
export const rentExempt = (size: number) => (size + 128) * 3_480 * 2;

export class FixtureRpc {
  slot = 9_000;
  blockHeight = 8_000;
  readonly blockhash = bs58.encode(Buffer.alloc(32, 4));
  readonly accounts = new Map<string, { owner: string; data: Buffer; lamports: number }>();
  /** Sonraki simülasyon yanıtları (sırayla); boşsa başarılı. */
  readonly simulations: Simulation[] = [];
  /** Gönderilen tx'ler. */
  readonly sent: VersionedTransaction[] = [];
  /** Gönderilen tx'in onay sonucu: null başarılı, değer tx hatası; `pending` onaylanmamış. */
  confirmation: unknown = null;
  prioritizationFees: number[] = [];
  messageFee = 5_000;
  balance = 2_000_000_000;
  /** Bu yöntemler hata döner (RPC kesintisi). */
  readonly failing = new Set<string>();

  reset(): void {
    this.accounts.clear();
    this.simulations.length = 0;
    this.sent.length = 0;
    this.confirmation = null;
    this.prioritizationFees = [];
    this.messageFee = 5_000;
    this.balance = 2_000_000_000;
    this.failing.clear();
    this.blockHeight = 8_000;
  }

  private account(address: string) {
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

  handle(method: string, params: unknown[]): unknown {
    if (this.failing.has(method)) throw Object.assign(new Error(`${method} kullanılamıyor`), { code: -32005 });
    const context = { slot: this.slot };
    switch (method) {
      case 'getSlot':
        return this.slot;
      case 'getBlockHeight':
        return this.blockHeight;
      case 'getBalance':
        return { context, value: this.balance };
      case 'getLatestBlockhash':
        return { context, value: { blockhash: this.blockhash, lastValidBlockHeight: this.blockHeight + 150 } };
      case 'getAccountInfo':
        return { context, value: this.account(params[0] as string) };
      case 'getMultipleAccounts':
        return { context, value: (params[0] as string[]).map((address) => this.account(address)) };
      case 'getMinimumBalanceForRentExemption':
        return rentExempt(params[0] as number);
      case 'getFeeForMessage':
        return { context, value: this.messageFee };
      case 'getRecentPrioritizationFees':
        return this.prioritizationFees.map((fee, index) => ({ slot: this.slot - index, prioritizationFee: fee }));
      case 'simulateTransaction': {
        const next = this.simulations.shift() ?? { err: null, logs: [] };
        return {
          context,
          value: { err: next.err, logs: next.logs, accounts: null, unitsConsumed: 150_000, returnData: null },
        };
      }
      case 'sendTransaction': {
        const tx = VersionedTransaction.deserialize(Buffer.from(params[0] as string, 'base64'));
        this.sent.push(tx);
        return bs58.encode(tx.signatures[0]!);
      }
      case 'getSignatureStatuses':
        return {
          context,
          value: (params[0] as string[]).map(() =>
            this.confirmation === 'pending'
              ? null
              : {
                  slot: this.slot,
                  confirmations: 1,
                  err: this.confirmation,
                  status: this.confirmation === null ? { Ok: null } : { Err: this.confirmation },
                  confirmationStatus: 'confirmed',
                },
          ),
        };
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
