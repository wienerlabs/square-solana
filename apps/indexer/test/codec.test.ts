import { SQUARE_IDLS, type SquareProgramName } from '@squaresdk/solana-sdk';
import { ProgramEventPayloadSchema } from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FinalizedTransaction } from '../src/chain.js';
import { createCodec, MIRRORED_ACCOUNTS, UndecodableAccountError, type Codec } from '../src/codec.js';
import { FixtureChain, startRpcServer, type RpcServer } from './fixtures/rpc-server.js';
import { PROGRAM_IDS, World } from './fixtures/world.js';

let server: RpcServer;
let world: World;
let codec: Codec;

beforeAll(async () => {
  const chain = new FixtureChain();
  server = await startRpcServer(chain);
  world = new World(chain, server.url);
  codec = createCodec(world.client);
});
afterAll(() => server.close());

/** Fixture tx'in logları, indexer'ın okuduğu biçimde. */
function finalized(signature: string): FinalizedTransaction {
  const tx = world.chain.txs.find((candidate) => candidate.signature === signature)!;
  return { signature, slot: tx.slot, blockTime: tx.blockTime, failed: false, logs: tx.logs, writableAccounts: [] };
}

const PROGRAMS = Object.keys(PROGRAM_IDS) as SquareProgramName[];

describe('event çözümü', () => {
  it("sözleşmedeki 40 event'in her biri çözülüyor ve şemaya uyan payload veriyor", () => {
    let total = 0;
    for (const program of PROGRAMS) {
      const anchor = world.programs[program];
      const events = anchor.idl.events!.map((event) => ({
        program,
        name: event.name,
        data: world.sample(program, event.name),
      }));
      const signature = world.tx({ program, events, computeBudget: true });
      const decoded = codec.events(finalized(signature));
      expect(decoded.truncated).toBe(false);
      expect(decoded.events.map((e) => e.name)).toEqual(SQUARE_IDLS[program].events.map((e) => e.name));
      decoded.events.forEach((event, index) => {
        expect(ProgramEventPayloadSchema.parse(event.payload)).toEqual(event.payload);
        expect(event).toMatchObject({ program, signature, instructionIndex: 1, eventIndex: index });
        const job = (event.payload.data as { job?: unknown }).job;
        expect(event.job).toBe(typeof job === 'string' ? job : null);
      });
      total += decoded.events.length;
    }
    expect(total).toBe(40);
  });

  it('CPI event üst talimatına sayılır; kırpılmış log bildirilir', () => {
    const job = world.key();
    const signature = world.tx({
      program: 'escrow',
      events: [
        { program: 'verifier', name: 'releaseRecorded', data: world.sample('verifier', 'releaseRecorded', { job }) },
        { program: 'escrow', name: 'finalized', data: world.sample('escrow', 'finalized', { job }) },
      ],
      truncated: true,
    });
    const decoded = codec.events(finalized(signature));
    expect(decoded.truncated).toBe(true);
    expect(decoded.events.map((e) => [e.program, e.name, e.instructionIndex, e.eventIndex, e.job])).toEqual([
      ['verifier', 'ReleaseRecorded', 0, 0, job.toBase58()],
      ['escrow', 'Finalized', 0, 1, job.toBase58()],
    ]);
  });
});

describe('hesap çözümü', () => {
  it('aynalanan her hesap tipi IDL JSON olarak çözülüyor', async () => {
    for (const program of PROGRAMS) {
      const anchor = world.programs[program];
      for (const kind of MIRRORED_ACCOUNTS[program]) {
        const index = (SQUARE_IDLS[program].accounts as readonly { name: string }[]).findIndex((a) => a.name === kind);
        const camel = anchor.idl.accounts![index]!.name;
        const address = world.key();
        await world.put(program, camel, address, world.sample(program, camel));
        const info = world.chain.accounts.get(address.toBase58())!;
        const decoded = codec.account(address.toBase58(), {
          ...info,
          owner: new PublicKey(info.owner),
          executable: false,
          rentEpoch: 0,
        });
        expect(decoded).toMatchObject({ program, kind });
        expect(typeof decoded!.json).toBe('object');
      }
    }
    expect(codec.accountKinds.map((kind) => kind.kind).sort()).toEqual(Object.values(MIRRORED_ACCOUNTS).flat().sort());
  });

  it('başka sahibin hesabı, aynalanmayan hesap ve kısa veri null', async () => {
    const address = world.key();
    await world.put('escrow', 'job', address, world.sample('escrow', 'job'));
    const info = world.chain.accounts.get(address.toBase58())!;
    const base = { executable: false, rentEpoch: 0, lamports: 1 };
    expect(codec.account(address.toBase58(), { ...base, owner: PROGRAM_IDS.policy, data: info.data })).toBeNull();
    expect(codec.account(address.toBase58(), { ...base, owner: PROGRAM_IDS.escrow, data: Buffer.alloc(4) })).toBeNull();
    expect(
      codec.account(address.toBase58(), { ...base, owner: PROGRAM_IDS.escrow, data: Buffer.alloc(64) }),
    ).toBeNull();
    const config = world.key();
    await world.put('escrow', 'escrowConfig', config, world.sample('escrow', 'escrowConfig'));
    const configInfo = world.chain.accounts.get(config.toBase58())!;
    expect(codec.account(address.toBase58(), { ...base, owner: PROGRAM_IDS.escrow, data: configInfo.data })).toBeNull();
  });

  it('discriminator uyup sözleşme IDL’iyle çözülemeyen hesap (eski dağıtımın düzeni) adlandırılmış hata verir', () => {
    const kind = codec.accountKinds.find((k) => k.kind === 'AgentRecord')!;
    const legacy = Buffer.concat([Buffer.from(kind.discriminator), Buffer.alloc(200, 0xff)]);
    const address = world.key().toBase58();
    let error: unknown;
    try {
      codec.account(address, {
        executable: false,
        rentEpoch: 0,
        lamports: 1,
        owner: PROGRAM_IDS.registry,
        data: legacy,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UndecodableAccountError);
    expect(error).toMatchObject({ program: 'registry', kind: 'AgentRecord', address });
    expect((error as Error).message).toContain(address);
  });
});
