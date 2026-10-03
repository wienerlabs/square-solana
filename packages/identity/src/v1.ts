// did:aip v1 AgentRecord'un çözülmesi. Canlı hesap düzeni dr-wilson-empty/aip-beta @ c427872
// (programs/aip-escrow/programs/aip-registry/src/lib.rs): 1366 baytlık Anchor hesabı, Borsh.
// wienerlabs/aip-beta 9655c15'teki 1048 baytlık eski düzen canlı hiçbir hesapla eşleşmez (Solana
// profili §9.2).
import { PublicKey } from '@solana/web3.js';

export interface V1AgentRecord {
  owner: PublicKey;
  agentId: string;
  did: string;
  name: string;
  endpoint: string;
  walletAddress: PublicKey;
  agentType: number;
  capabilities: { name: string; description: string }[];
  pricePerTask: bigint;
  version: string;
  registeredAt: bigint;
  updatedAt: bigint;
  bump: number;
}

class BorshReader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  private take(length: number): Uint8Array {
    if (this.offset + length > this.data.length) throw new Error('v1 AgentRecord: veri erken bitti');
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private view(length: number): DataView {
    const bytes = this.take(length);
    return new DataView(bytes.buffer, bytes.byteOffset, length);
  }

  pubkey = () => new PublicKey(this.take(32));
  u8 = () => this.take(1)[0]!;
  u32 = () => this.view(4).getUint32(0, true);
  u64 = () => this.view(8).getBigUint64(0, true);
  i64 = () => this.view(8).getBigInt64(0, true);
  string = () => new TextDecoder('utf-8', { fatal: true }).decode(this.take(this.u32()));
  skip = (length: number) => void this.take(length);
}

/** Discriminator'dan sonraki gövdeyi çözer; düzen tutmazsa fırlatır. */
export function decodeV1AgentRecord(data: Uint8Array): V1AgentRecord {
  const r = new BorshReader(data);
  r.skip(8);
  const owner = r.pubkey();
  const agentId = r.string();
  const did = r.string();
  const name = r.string();
  const endpoint = r.string();
  const walletAddress = r.pubkey();
  const agentType = r.u8();
  const capabilities = Array.from({ length: r.u32() }, () => ({ name: r.string(), description: r.string() }));
  return {
    owner,
    agentId,
    did,
    name,
    endpoint,
    walletAddress,
    agentType,
    capabilities,
    pricePerTask: r.u64(),
    version: r.string(),
    registeredAt: r.i64(),
    updatedAt: r.i64(),
    bump: r.u8(),
  };
}
