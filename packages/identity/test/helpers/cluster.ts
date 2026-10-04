// Test fixture: bir kümenin RPC'si (genesis hash + hesaplar) ve kart sunucusu. Çözücünün yaptığı
// ağ çağrılarını kaydeder; "hiçbir şey okunmadan" beklentileri bununla denetlenir.
import { BN, Program, type Idl } from '@anchor-lang/core';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';

export class TestCluster {
  private readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly calls: string[] = [];
  failReads = false;

  constructor(
    readonly genesisHash: string,
    readonly slot: number,
  ) {}

  setAccount(address: PublicKey, owner: PublicKey, data: Buffer): void {
    this.accounts.set(address.toBase58(), { data, owner, lamports: 1, executable: false, rentEpoch: 0 });
  }

  connection(): Connection {
    const { accounts, calls, genesisHash, slot } = this;
    const failReads = () => this.failReads;
    return {
      async getGenesisHash() {
        calls.push('getGenesisHash');
        return genesisHash;
      },
      async getAccountInfoAndContext(address: PublicKey) {
        calls.push(`getAccountInfoAndContext:${address.toBase58()}`);
        if (failReads()) throw new Error('rpc unavailable');
        return { context: { slot }, value: accounts.get(address.toBase58()) ?? null };
      },
    } as unknown as Connection;
  }
}

export interface LogicalRecord {
  creator: string;
  agentId: string;
  bump: number;
  owner: string;
  wallet: string;
  agentCardUri: string;
  agentCardHash: string;
  status: 'Active' | 'Inactive' | 'Deregistered';
  registeredAt: number;
  updatedAt: number;
}

/** Mantıksal kaydı (test vektörü) registry IDL'iyle hesap verisine kodlar. */
export async function encodeRecord(registry: string, record: LogicalRecord): Promise<Buffer> {
  const program = new Program({ ...(SQUARE_IDLS.registry as unknown as Idl), address: registry }, {} as never);
  const status = { [record.status.charAt(0).toLowerCase() + record.status.slice(1)]: {} };
  return program.coder.accounts.encode('agentRecord', {
    creator: new PublicKey(record.creator),
    agentId: record.agentId,
    bump: record.bump,
    owner: new PublicKey(record.owner),
    wallet: new PublicKey(record.wallet),
    agentCardUri: record.agentCardUri,
    agentCardHash: Array.from(Buffer.from(record.agentCardHash, 'hex')),
    status,
    registeredAt: new BN(record.registeredAt),
    updatedAt: new BN(record.updatedAt),
  });
}

/** Kart sunucusu: URL → gövde; olmayan URL 404. Yapılan istekleri kaydeder. */
export function cardServer(bodies: Readonly<Record<string, string | Uint8Array>>) {
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    const body = bodies[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? new TextEncoder().encode(body) : body, { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}
