// Testler için sahte Solana JSON-RPC sunucusu. Ödeyen istemcinin (mint bilgisi, blok hash'i) ve kendi
// facilitator'ımızın (simülasyon, gönderme, onay) çağırdığı yöntemleri yanıtlar; zincire bir şey
// yazılmaz. Böylece resmi exact şemasının istemci ve facilitator yolları ağ olmadan uçtan uca sınanır.
// Servisler (ör. compliance-api) kendi ücretli route testlerinde de kullanır.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getBase58Decoder, getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@x402/svm';

export interface FakeSolanaRpc {
  readonly url: string;
  /** `sendTransaction` ile gelen işlemler (base64, ücret ödeyen imzası dahil). */
  readonly sent: readonly string[];
  /** Mint hesabı ekler (SPL Token programına ait, başlatılmış). */
  addMint(address: string, decimals: number): void;
  /** Sonraki simülasyonların sonucu: `null` başarı, başka değer işlem hatası. */
  setSimulationError(error: unknown): void;
  /** Sonraki gönderilen işlemlerin onay durumundaki hata (`null`: başarılı). */
  setConfirmationError(error: unknown): void;
  close(): Promise<void>;
}

interface RpcRequest {
  readonly id: unknown;
  readonly method: string;
  readonly params?: readonly unknown[];
}

const MINT_SIZE = 82;

/** SPL Token `Mint` hesabının baytları: yetkisiz, arzı 0, başlatılmış. */
function mintAccountData(decimals: number): Buffer {
  const data = Buffer.alloc(MINT_SIZE);
  data.writeUInt8(decimals, 44);
  data.writeUInt8(1, 45);
  return data;
}

export async function startFakeSolanaRpc(): Promise<FakeSolanaRpc> {
  const base58 = getBase58Decoder();
  const mints = new Map<string, number>();
  const sent: string[] = [];
  const blockhash = base58.decode(crypto.getRandomValues(new Uint8Array(32)));
  let simulationError: unknown = null;
  let confirmationError: unknown = null;
  let slot = 1;

  const context = () => ({ apiVersion: '2.3.0', slot: slot++ });
  const handle = (request: RpcRequest): unknown => {
    const params = request.params ?? [];
    switch (request.method) {
      case 'getAccountInfo': {
        const decimals = mints.get(String(params[0]));
        if (decimals === undefined) return { context: context(), value: null };
        return {
          context: context(),
          value: {
            data: [mintAccountData(decimals).toString('base64'), 'base64'],
            executable: false,
            lamports: 1_461_600,
            owner: TOKEN_PROGRAM_ADDRESS,
            rentEpoch: 0,
            space: MINT_SIZE,
          },
        };
      }
      case 'getLatestBlockhash':
        return { context: context(), value: { blockhash, lastValidBlockHeight: 1_000_000 } };
      case 'simulateTransaction':
        return {
          context: context(),
          value: { err: simulationError, logs: [], accounts: null, unitsConsumed: 1_000, returnData: null },
        };
      case 'sendTransaction': {
        const wire = String(params[0]);
        sent.push(wire);
        const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
        return getSignatureFromTransaction(transaction);
      }
      case 'getSignatureStatuses':
        return {
          context: context(),
          value: (params[0] as unknown[]).map(() => ({
            slot,
            confirmations: null,
            err: confirmationError,
            status: confirmationError ? { Err: confirmationError } : { Ok: null },
            confirmationStatus: 'confirmed',
          })),
        };
      default:
        throw Object.assign(new Error(`sahte RPC bu yöntemi bilmiyor: ${request.method}`), { code: -32601 });
    }
  };

  const respond = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest;
    let body: unknown;
    try {
      body = { jsonrpc: '2.0', id: request.id, result: handle(request) };
    } catch (error) {
      const code = (error as { code?: number }).code ?? -32603;
      body = { jsonrpc: '2.0', id: request.id, error: { code, message: (error as Error).message } };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    respond(req, res).catch((error: unknown) => res.writeHead(500).end(String(error)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    addMint: (address, decimals) => void mints.set(address, decimals),
    setSimulationError: (error) => void (simulationError = error),
    setConfirmationError: (error) => void (confirmationError = error),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
