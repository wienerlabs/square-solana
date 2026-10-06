// Test fixture: Square MCP sunucusuna SDK'nın gerçek `Client`'ıyla bellek içi taşımadan bağlanır. Zincir,
// adım seçimi ve gönderim için bellekteki `FakeChain`'dir (gerçek RPC ile `chain.ts` testi ve stdio uçtan uca
// testi ayrı). Gönderilen her ham tx `sent`'e düşer; testler imzasız tx'in hiç gönderilmediğini buradan denetler.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createApi } from '../../src/api.js';
import type { ChainJob, ConfirmationStatus, Settlement, SquareChain } from '../../src/chain.js';
import { createSquareMcpServer } from '../../src/server.js';
import type { LocalSigner } from '../../src/transactions.js';
import { FakeApi } from './fake-api.js';
import { ESCROW_PROGRAM } from './fixtures.js';

export class FakeChain implements SquareChain {
  readonly escrowProgramId = ESCROW_PROGRAM;
  readonly jobs = new Map<string, ChainJob>();
  readonly sent: VersionedTransaction[] = [];
  settlementValue: Settlement = {
    mint: Keypair.generate().publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    decimals: 6,
    travelRuleThreshold: 0n,
  };
  confirmation: { status: ConfirmationStatus; err: unknown } = { status: 'confirmed', err: null };

  async settlement() {
    return this.settlementValue;
  }

  jobAddress(institution: PublicKey, specHash: Uint8Array) {
    return PublicKey.findProgramAddressSync([Buffer.from('job'), institution.toBytes(), specHash], ESCROW_PROGRAM)[0];
  }

  async job(address: PublicKey) {
    return this.jobs.get(address.toBase58()) ?? null;
  }

  async sendRaw(raw: Uint8Array) {
    const tx = VersionedTransaction.deserialize(raw);
    this.sent.push(tx);
    return bs58.encode(tx.signatures[0]!);
  }

  async waitForConfirmation() {
    return this.confirmation;
  }
}

export interface Harness {
  api: FakeApi;
  chain: FakeChain;
  client: Client;
  /** Tool'u çağırır, JSON gövdesini çözer. */
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export function parse(result: CallToolResult) {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('metin içerik bekleniyordu');
  return { isError: result.isError === true, body: JSON.parse(first.text) as Record<string, unknown> };
}

export async function connect(
  options: { write?: boolean; signer?: LocalSigner | null; apiKey?: string | null } = {},
): Promise<Harness> {
  const api = new FakeApi();
  const chain = new FakeChain();
  const server = createSquareMcpServer({
    network: 'localnet',
    api: createApi({
      apiUrl: 'http://square.test',
      timeoutMs: 5_000,
      apiKey: options.apiKey ?? null,
      fetch: api.fetch,
    }),
    write: options.write === false ? null : { chain, signer: options.signer ?? null },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    api,
    chain,
    client,
    async call(name, args = {}) {
      return parse((await client.callTool({ name, arguments: args })) as CallToolResult);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
