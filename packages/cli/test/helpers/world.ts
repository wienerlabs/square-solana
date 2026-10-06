// Test dünyası: bellekteki zincirde SDK istemcisi, imzacılar ve gönderilen tx'leri kaydeden bağlam. Komutların
// kurduğu tx'ler zincire gitmez; talimatları program coder'ıyla çözülüp denetlenir.
import type { BorshInstructionCoder, Idl, Program } from '@anchor-lang/core';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createSquareClient, type BuiltTx, type SquareClient } from '@squaresdk/solana-sdk';
import type { CliConfig } from '../../src/config.js';
import { PROGRAM_IDS, type Context } from '../../src/context.js';
import type { Io } from '../../src/io.js';
import { TestChain } from './chain.js';
import { createSampler, plain } from './idl-sample.js';

export const NOW = 1_790_000_000;

export type ProgramName = 'registry' | 'policy' | 'verifier' | 'escrow';

export class World {
  readonly chain = new TestChain();
  readonly client: SquareClient = createSquareClient({
    connection: this.chain.connection(),
    programIds: PROGRAM_IDS,
    commitment: 'confirmed',
  });
  readonly signer = Keypair.generate();
  readonly feePayer = Keypair.generate();
  readonly sent: { label: string; built: BuiltTx }[] = [];
  readonly out: string[] = [];
  readonly err: string[] = [];
  now = NOW;
  config: CliConfig = {
    cluster: 'devnet',
    rpcUrl: 'http://127.0.0.1:9',
    commitment: 'confirmed',
    keypairPath: '/dev/null',
    feePayerPath: null,
    computeUnitPrice: null,
    lookupTable: null,
    prover: null,
    json: true,
  };

  readonly io: Io = { stdout: (t) => this.out.push(t), stderr: (t) => this.err.push(t) };

  ctx(): Context {
    return {
      config: this.config,
      connection: this.chain.connection(),
      client: this.client,
      signer: this.signer,
      feePayer: this.feePayer,
      io: this.io,
      options: () => ({ feePayer: this.feePayer.publicKey }),
      send: async (label, build) => {
        const built = await build();
        this.sent.push({ label, built });
        return { signature: `sig-${this.sent.length}` };
      },
      now: async () => this.now,
    };
  }

  program(name: ProgramName): Program<Idl> {
    return this.client[name].program as unknown as Program<Idl>;
  }

  /** IDL'den örneklenmiş, `overrides` ile değiştirilmiş hesap. */
  async put(name: ProgramName, account: string, address: PublicKey, overrides: Record<string, unknown> = {}) {
    const program = this.program(name);
    const data = { ...createSampler(program.idl).struct(account), ...overrides };
    this.chain.setAccount(address, program.programId, await program.coder.accounts.encode(account, data));
    return data;
  }

  mint(): PublicKey {
    const address = Keypair.generate().publicKey;
    this.chain.setAccount(address, TOKEN_PROGRAM_ID, Buffer.alloc(82));
    return address;
  }

  /** `index`. gönderilen tx'teki Square talimatı: adı, argümanları ve hesapları (adlarıyla). */
  decode(index: number, name: ProgramName) {
    const { built } = this.sent[index]!;
    const message = built.transaction.message;
    const keys = message.staticAccountKeys;
    const program = this.program(name);
    const ix = message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(program.programId))!;
    const decoded = (program.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data))!;
    const def = program.idl.instructions.find((i) => i.name === decoded.name)!;
    const accounts = Object.fromEntries(
      def.accounts.map((a, i) => [a.name, keys[ix.accountKeyIndexes[i]!]!.toBase58()]),
    );
    return { name: decoded.name, data: plain(decoded.data) as Record<string, unknown>, accounts, built };
  }
}

export const b58 = (key: PublicKey) => key.toBase58();
