import { BN, type Idl, type IdlType, type Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import * as types from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { createSquareClient } from '../src/client.js';
import { toIdlJson } from '../src/idl-json.js';
import { SQUARE_IDLS, type SquareProgramName } from '../src/programs.js';
import { TestChain } from './helpers/chain.js';
import { createSampler } from './helpers/idl-sample.js';
import { PROGRAM_IDS } from './helpers/ids.js';

const client = createSquareClient({ connection: new TestChain().connection(), programIds: PROGRAM_IDS });
const programs: Record<SquareProgramName, Program<Idl>> = {
  registry: client.registry.program as unknown as Program<Idl>,
  policy: client.policy.program as unknown as Program<Idl>,
  verifier: client.verifier.program as unknown as Program<Idl>,
  escrow: client.escrow.program as unknown as Program<Idl>,
};
const schemas = types as unknown as Record<string, { parse(value: unknown): unknown } | undefined>;
const defined = (name: string): IdlType => ({ defined: { name } });

describe('toIdlJson', () => {
  for (const [name, program] of Object.entries(programs) as [SquareProgramName, Program<Idl>][]) {
    it(`${name}: her hesap ve event, çözücünün çıktısından üretilen şemaya uyan JSON verir`, () => {
      const sample = createSampler(program.idl);
      // Anchor'ın IDL'i camelCase; üretilen şemalar ham IDL adlarıyla (`Job` → `JobSchema`), aynı sırada.
      const raw = SQUARE_IDLS[name] as unknown as Idl;
      const names = [...(program.idl.accounts ?? []), ...(program.idl.events ?? [])].map((item) => item.name);
      expect(names.length).toBeGreaterThan(0);
      for (const typeName of names) {
        const index = program.idl.types!.findIndex((t) => t.name === typeName);
        const schema = schemas[`${raw.types![index]!.name}Schema`]!;
        // Değer, kodlanıp çözülerek Anchor'ın gerçek çıktı biçimine getirilir.
        const value = program.coder.types.decode(
          typeName,
          program.coder.types.encode(typeName, sample.struct(typeName)),
        );
        const json = toIdlJson(program.idl, defined(typeName), value);
        expect(schema.parse(json)).toEqual(json);
      }
    });
  }

  it('kodlama kuralları: adres, u64, i64, hex, option, enum', () => {
    const idl = programs.escrow.idl;
    const sample = createSampler(idl);
    const job = programs.escrow.coder.types.decode(
      'job',
      programs.escrow.coder.types.encode('job', sample.struct('job')),
    );
    const json = toIdlJson(idl, defined('job'), job) as Record<string, unknown>;
    expect(json.institution).toBe((job.institution as PublicKey).toBase58());
    expect(json.amount).toBe((job.amount as BN).toString());
    expect(json.createdAt).toBe((job.createdAt as BN).toNumber());
    expect(json.specHash).toBe(Buffer.from(job.specHash as number[]).toString('hex'));
    expect(json.policy).toBe((job.policy as PublicKey).toBase58());
    expect(toIdlJson(idl, defined('job'), { ...job, policy: null })).toMatchObject({ policy: null });
    expect(toIdlJson(idl, defined('jobStatus'), { delivered: {} })).toBe('delivered');
    expect(toIdlJson(idl, defined('disputeResolution'), { split: { agentAmount: new BN(500_000) } })).toEqual({
      kind: 'split',
      agentAmount: '500000',
    });
    expect(toIdlJson(idl, defined('disputeResolution'), { pending: {} })).toEqual({ kind: 'pending' });
    expect(toIdlJson(idl, 'bytes', Buffer.from([1, 2, 3]))).toBe('AQID');
    expect(toIdlJson(idl, 'i128', new BN(-5))).toBe('-5');
    expect(toIdlJson(idl, 'u64', 7n)).toBe('7');
    expect(toIdlJson(idl, { vec: 'u16' }, [1, 2])).toEqual([1, 2]);
    expect(toIdlJson(idl, { array: ['u16', 2] }, [1, 2])).toEqual([1, 2]);
  });

  it('beklenen biçimde olmayan değer hata verir', () => {
    const idl = programs.escrow.idl;
    const key = PublicKey.default;
    const cases: [IdlType, unknown, RegExp][] = [
      ['pubkey', key.toBase58(), /PublicKey bekleniyordu/],
      ['u64', new BN(-1), /negatif olmayan/],
      ['u64', 5, /BN bekleniyordu/],
      ['i64', new BN('9007199254740993'), /güvenli tamsayı/],
      ['u8', 256, /u8 bekleniyordu/],
      ['u16', 1.5, /u16 bekleniyordu/],
      ['bool', 1, /boolean/],
      ['string', null, /string bekleniyordu \(null\)/],
      ['bytes', 'AQID', /bayt dizisi/],
      ['f64', 1, /desteklenmeyen tip f64/],
      [{ array: ['u8', 32] }, [1, 2], /32 bayt/],
      [{ array: ['u8', 2] }, [1, 300], /bayt dizisi/],
      [{ array: ['u16', 2] }, [1], /2 öğeli dizi/],
      [{ vec: 'u8' }, 'x', /dizi bekleniyordu/],
      [defined('jobStatus'), 'open', /enum nesnesi/],
      [defined('jobStatus'), { open: {}, funded: {} }, /tek varyantlı/],
      [defined('jobStatus'), { lost: {} }, /lost varyantı yok/],
      [defined('nope'), {}, /nope tipi yok/],
      [defined('escrowParams'), {}, /alan yok/],
      [defined('escrowParams'), 5, /nesne bekleniyordu/],
      [{ coption: 'u8' } as unknown as IdlType, 1, /desteklenmeyen tip/],
    ];
    for (const [type, value, error] of cases) expect(() => toIdlJson(idl, type, value)).toThrow(error);
  });

  it('demet alanları ve desteklenmeyen tip türleri', () => {
    const idl: Idl = {
      address: PublicKey.default.toBase58(),
      metadata: { name: 'fixture', version: '0.0.0', spec: '0.1.0' },
      instructions: [],
      types: [
        { name: 'pair', type: { kind: 'struct', fields: ['u8', 'bool'] } },
        { name: 'shape', type: { kind: 'enum', variants: [{ name: 'Dot' }, { name: 'Line', fields: ['u8'] }] } },
        { name: 'alias', type: { kind: 'type', alias: 'u8' } },
        { name: 'boxed', generics: [{ kind: 'type', name: 'T' }], type: { kind: 'struct', fields: [] } },
      ],
    };
    expect(toIdlJson(idl, defined('pair'), [7, true])).toEqual([7, true]);
    expect(toIdlJson(idl, defined('pair'), { 0: 7, 1: false })).toEqual([7, false]);
    expect(() => toIdlJson(idl, defined('pair'), { a: 1 })).toThrow(/demet bekleniyordu/);
    expect(() => toIdlJson(idl, defined('shape'), { line: [1] })).toThrow(/demet alanlı enum/);
    expect(() => toIdlJson(idl, defined('alias'), 1)).toThrow(/desteklenmeyen tip türü type/);
    expect(() => toIdlJson(idl, defined('boxed'), {})).toThrow(/generic/);
    expect(() => toIdlJson(idl, { array: ['u8', { generic: 'N' }] }, [])).toThrow(/generic dizi/);
  });
});
