// Test fixture: Square hesaplarını ve tx'lerini IDL coder'ıyla kodlayıp `FixtureChain`'e koyar. Tx logları
// çalışma zamanının biçimindedir (`invoke [n]`, `Program data:`, `success` / `failed`, `Log truncated`).
import { randomBytes } from 'node:crypto';
import type { Idl, Program } from '@anchor-lang/core';
import {
  createSquareClient,
  SQUARE_IDLS,
  type SquareClient,
  type SquareProgramIds,
  type SquareProgramName,
} from '@squaresdk/solana-sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { FixtureChain, FixtureKey } from './rpc-server.js';
import { sample } from './sample.js';

/** IDL'lerin bildirdiği program kimlikleri. */
export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

export interface FixtureEvent {
  program: SquareProgramName;
  /** Anchor'ın camelCase event adı. */
  name: string;
  data: Record<string, unknown>;
}

export interface TxSpec {
  program: SquareProgramName;
  events?: FixtureEvent[];
  writable?: PublicKey[];
  /** Lookup table'dan yüklenen yazılabilir hesaplar (v0 tx). */
  loaded?: PublicKey[];
  err?: unknown;
  truncated?: boolean;
  /** Ana programın logundaki ek `Program data:` satırları (ham base64). */
  rawData?: string[];
  finalized?: boolean;
  /** Önce bir compute budget talimatı. */
  computeBudget?: boolean;
}

export class World {
  readonly client: SquareClient;
  readonly programs: Record<SquareProgramName, Program<Idl>>;
  private slot = 100;

  constructor(
    readonly chain: FixtureChain,
    rpcUrl: string,
  ) {
    this.client = createSquareClient({
      connection: new Connection(rpcUrl, 'finalized'),
      programIds: PROGRAM_IDS,
      commitment: 'finalized',
    });
    this.programs = {
      registry: this.client.registry.program,
      policy: this.client.policy.program,
      verifier: this.client.verifier.program,
      escrow: this.client.escrow.program,
    } as unknown as Record<SquareProgramName, Program<Idl>>;
  }

  key(): PublicKey {
    return Keypair.generate().publicKey;
  }

  /** Örnek değer (Anchor biçiminde), alanları değiştirilmiş. */
  sample(program: SquareProgramName, type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return sample(this.programs[program].idl, type, overrides);
  }

  async put(program: SquareProgramName, account: string, address: PublicKey, value: Record<string, unknown>) {
    const data = await this.programs[program].coder.accounts.encode(account, value);
    this.chain.setAccount(address.toBase58(), {
      owner: PROGRAM_IDS[program].toBase58(),
      data,
      lamports: 2_000_000,
    });
    return value;
  }

  eventLine(event: FixtureEvent): string {
    const program = this.programs[event.program];
    const def = program.idl.events!.find((e) => e.name === event.name)!;
    const body = program.coder.types.encode(event.name, event.data);
    return `Program data: ${Buffer.concat([Buffer.from(def.discriminator), body]).toString('base64')}`;
  }

  tx(spec: TxSpec): string {
    this.slot += 1;
    const signature = bs58.encode(randomBytes(64));
    const main = PROGRAM_IDS[spec.program].toBase58();
    const feePayer = this.key().toBase58();
    this.chain.setAccount(feePayer, { owner: SYSTEM_PROGRAM, data: Buffer.alloc(0), lamports: 1_000_000_000 });
    const logs: string[] = [];
    if (spec.computeBudget) logs.push(`Program ${COMPUTE_BUDGET} invoke [1]`, `Program ${COMPUTE_BUDGET} success`);
    logs.push(`Program ${main} invoke [1]`, 'Program log: Instruction: Fixture');
    const cpiPrograms = new Set<string>();
    let truncated = false;
    for (const event of spec.events ?? []) {
      const id = PROGRAM_IDS[event.program].toBase58();
      if (id === main) logs.push(this.eventLine(event));
      else {
        cpiPrograms.add(id);
        logs.push(`Program ${id} invoke [2]`, this.eventLine(event), `Program ${id} success`);
      }
    }
    for (const data of spec.rawData ?? []) logs.push(`Program data: ${data}`);
    if (spec.truncated) {
      logs.push('Log truncated');
      truncated = true;
    }
    if (!truncated) {
      logs.push(`Program ${main} consumed 12000 of 200000 compute units`);
      logs.push(spec.err ? `Program ${main} failed: custom program error: 0x1770` : `Program ${main} success`);
    }
    const keys: FixtureKey[] = [
      { pubkey: feePayer, signer: true, writable: true },
      ...(spec.writable ?? []).map((key) => ({ pubkey: key.toBase58(), signer: false, writable: true })),
      ...(spec.computeBudget ? [{ pubkey: COMPUTE_BUDGET, signer: false, writable: false }] : []),
      ...[...cpiPrograms].map((pubkey) => ({ pubkey, signer: false, writable: false })),
      { pubkey: main, signer: false, writable: false },
    ];
    this.chain.addTx({
      signature,
      slot: this.slot,
      blockTime: 1_790_000_000 + this.slot,
      err: spec.err ?? null,
      logs,
      keys,
      loaded: spec.loaded
        ? { table: this.key().toBase58(), writable: spec.loaded.map((key) => key.toBase58()), readonly: [] }
        : null,
      finalized: spec.finalized ?? true,
    });
    return signature;
  }
}
