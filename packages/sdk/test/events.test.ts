import type { Idl, Program } from '@anchor-lang/core';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createSquareClient } from '../src/client.js';
import type { SquareProgramName } from '../src/programs.js';
import { TestChain } from './helpers/chain.js';
import { createSampler, plain } from './helpers/idl-sample.js';
import { PROGRAM_IDS } from './helpers/ids.js';

const client = createSquareClient({ connection: new TestChain().connection(), programIds: PROGRAM_IDS });
const programs: Record<SquareProgramName, Program<Idl>> = {
  registry: client.registry.program as unknown as Program<Idl>,
  policy: client.policy.program as unknown as Program<Idl>,
  verifier: client.verifier.program as unknown as Program<Idl>,
  escrow: client.escrow.program as unknown as Program<Idl>,
};
const context = { signature: 'sig', slot: 77 };

/** Bir event'in `Program data:` log satırı: discriminator + Borsh gövdesi, base64. */
function eventLine(program: Program<Idl>, name: string, data: unknown): string {
  const event = program.idl.events!.find((e) => e.name === name)!;
  const body = program.coder.types.encode(name, data);
  return `Program data: ${Buffer.concat([Buffer.from(event.discriminator), body]).toString('base64')}`;
}

const invoke = (id: string, depth = 1) => `Program ${id} invoke [${depth}]`;
const success = (id: string) => `Program ${id} success`;

describe('decodeEvents', () => {
  for (const [name, program] of Object.entries(programs)) {
    it(`${name}: sözleşmedeki her event çözülüyor`, () => {
      const sample = createSampler(program.idl);
      const id = program.programId.toBase58();
      const events = program.idl.events ?? [];
      expect(events.length).toBeGreaterThan(0);
      const inputs = events.map((event) => ({ name: event.name, data: sample.struct(event.name) }));
      const logs = [invoke(id), ...inputs.map((e) => eventLine(program, e.name, e.data)), success(id)];
      const decoded = client.decodeEvents(logs, context);
      expect(decoded.map((e) => e.name)).toEqual(inputs.map((e) => e.name));
      decoded.forEach((event, index) => {
        expect(plain(event.data)).toEqual(plain(inputs[index]!.data));
        expect(event.signature).toBe('sig');
        expect(event.slot).toBe(77);
      });
    });
  }

  it('CPI sırasını korur, Square dışı programların verisini atlar', () => {
    const escrow = programs.escrow;
    const verifier = programs.verifier;
    const foreign = Keypair.generate().publicKey.toBase58();
    const sampleEscrow = createSampler(escrow.idl);
    const sampleVerifier = createSampler(verifier.idl);
    const released = sampleVerifier.struct('releaseRecorded');
    const finalized = sampleEscrow.struct('finalized');
    const logs = [
      invoke(escrow.programId.toBase58()),
      'Program log: Instruction: FinalizePayment',
      invoke(verifier.programId.toBase58(), 2),
      eventLine(verifier, 'releaseRecorded', released),
      `Program ${verifier.programId.toBase58()} consumed 1200 of 200000 compute units`,
      success(verifier.programId.toBase58()),
      invoke(foreign, 2),
      'Program data: AAAAAAAAAAA=',
      success(foreign),
      eventLine(escrow, 'finalized', finalized),
      success(escrow.programId.toBase58()),
    ];
    const decoded = client.decodeEvents(logs, context);
    expect(decoded.map((e) => e.name)).toEqual(['releaseRecorded', 'finalized']);
  });

  it("IDL'de olmayan bir event ve tutarsız log yığını hata verir", () => {
    const id = programs.escrow.programId.toBase58();
    expect(() => client.decodeEvents([invoke(id), 'Program data: AAAAAAAAAAA=', success(id)], context)).toThrow(
      /IDL'de olmayan/,
    );
    expect(() => client.decodeEvents([invoke(id), success(programs.policy.programId.toBase58())], context)).toThrow(
      /yığın/,
    );
  });
});

describe('mapError', () => {
  const failed = (id: string, code: number) => `Program ${id} failed: custom program error: 0x${code.toString(16)}`;

  for (const [name, program] of Object.entries(programs)) {
    it(`${name}: sözleşmedeki her hata (program, kod, ad) olarak eşlenir`, () => {
      const id = program.programId.toBase58();
      for (const error of program.idl.errors ?? []) {
        const mapped = client.mapError({ logs: [invoke(id), failed(id, error.code)] });
        expect(mapped).toEqual({ program: name, code: error.code, name: error.name });
      }
    });
  }

  it('Anchor çerçeve hatası adını logdan alır', () => {
    const id = programs.escrow.programId.toBase58();
    const logs = [
      invoke(id),
      'Program log: AnchorError caused by account: job. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.',
      failed(id, 2006),
    ];
    expect(client.mapError({ transactionLogs: logs })).toEqual({
      program: 'escrow',
      code: 2006,
      name: 'ConstraintSeeds',
    });
    expect(client.mapError({ value: { logs } })).toEqual({ program: 'escrow', code: 2006, name: 'ConstraintSeeds' });
  });

  it('Square dışı program, log yokluğu ve bilinmeyen kod', () => {
    const foreign = Keypair.generate().publicKey.toBase58();
    expect(client.mapError({ logs: [failed(foreign, 6000)] })).toBeNull();
    expect(client.mapError(new Error('network'))).toBeNull();
    expect(client.mapError('boom')).toBeNull();
    expect(client.mapError({ logs: ['Program log: ok'] })).toBeNull();
    const id = programs.escrow.programId.toBase58();
    expect(() => client.mapError({ logs: [failed(id, 9999)] })).toThrow(/9999/);
  });
});
