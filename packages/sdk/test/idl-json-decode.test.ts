import type { Idl, IdlType, Program } from '@anchor-lang/core';
import { describe, expect, it } from 'vitest';
import { createSquareClient } from '../src/client.js';
import { fromIdlJson, IdlJsonError } from '../src/idl-json-decode.js';
import { toIdlJson } from '../src/idl-json.js';
import type { SquareProgramName } from '../src/programs.js';
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
const defined = (name: string): IdlType => ({ defined: { name } });

describe('fromIdlJson', () => {
  for (const [name, program] of Object.entries(programs)) {
    it(`${name}: her tip ve instruction argümanı JSON'dan aynı baytlara döner`, () => {
      // Örnek üretici her tipte yeniden kurulur: sayaç küçük kalır, u64 örnekleri aralıkta.
      for (const type of program.idl.types ?? []) {
        if (type.type.kind !== 'struct') continue;
        const sample = createSampler(program.idl);
        const value = sample.struct(type.name);
        const json = toIdlJson(program.idl, defined(type.name), value);
        const back = fromIdlJson(program.idl, defined(type.name), json);
        expect(program.coder.types.encode(type.name, back)).toEqual(program.coder.types.encode(type.name, value));
      }
      for (const ix of program.idl.instructions) {
        const sample = createSampler(program.idl);
        const args = Object.fromEntries(ix.args.map((arg) => [arg.name, sample.value(arg.type as never)]));
        const back = Object.fromEntries(
          ix.args.map((arg) => [
            arg.name,
            fromIdlJson(program.idl, arg.type, toIdlJson(program.idl, arg.type, args[arg.name]), `args.${arg.name}`),
          ]),
        );
        expect(program.coder.instruction.encode(ix.name, back)).toEqual(
          program.coder.instruction.encode(ix.name, args),
        );
      }
    });
  }

  it('enum ve option', () => {
    const idl = programs.escrow.idl;
    expect(fromIdlJson(idl, defined('jobStatus'), 'delivered')).toEqual({ delivered: {} });
    expect(fromIdlJson(idl, defined('disputeResolution'), { kind: 'pending' })).toEqual({ pending: {} });
    const split = fromIdlJson(idl, defined('disputeResolution'), { kind: 'split', agentAmount: '7' }) as {
      split: { agentAmount: { toString(): string } };
    };
    expect(split.split.agentAmount.toString()).toBe('7');
    expect(fromIdlJson(idl, { option: 'pubkey' }, null)).toBeNull();
    expect(fromIdlJson(idl, 'bytes', 'AQID')).toEqual(Buffer.from([1, 2, 3]));
  });

  it('geçersiz değer, alanın yoluyla hata verir', () => {
    const idl = programs.escrow.idl;
    const cases: [IdlType, unknown, RegExp][] = [
      ['pubkey', 'x', /base58 adres/],
      ['pubkey', '1'.repeat(44), /geçerli bir adres değil/],
      ['u64', '-1', /aralık dışında/],
      ['u64', '18446744073709551616', /aralık dışında/],
      ['u64', 5, /ondalık dize/],
      ['u64', '01', /ondalık dize/],
      ['u128', '-1', /aralık dışında/],
      ['i128', '170141183460469231731687303715884105728', /aralık dışında/],
      ['i64', 2 ** 60, /güvenli tamsayı/],
      ['u8', 256, /u8 aralığında/],
      ['bool', 'true', /boolean/],
      ['string', 1, /dize/],
      ['bytes', 'A', /base64/],
      ['f32', 1, /desteklenmeyen tip f32/],
      [{ array: ['u8', 2] }, 'ABCD', /2 baytlık küçük harf hex/],
      [{ array: ['u16', 2] }, [1], /2 öğeli dizi/],
      [{ array: ['u8', { generic: 'N' }] } as unknown as IdlType, [], /generic dizi/],
      [{ vec: 'u8' }, 1, /dizi bekleniyordu/],
      [defined('jobStatus'), 'lost', /bilinmeyen değer: lost/],
      [defined('jobStatus'), 1, /dize bekleniyordu/],
      [defined('disputeResolution'), { agentAmount: '1' }, /`kind` alanı/],
      [defined('disputeResolution'), { kind: 'pending', extra: 1 }, /bilinmeyen alan: extra/],
      [defined('escrowParams'), [], /nesne bekleniyordu/],
      [defined('escrowParams'), { nope: 1 }, /bilinmeyen alan: nope/],
      [defined('nope'), {}, /nope tipi yok/],
      [{ coption: 'u8' } as unknown as IdlType, 1, /desteklenmeyen tip/],
    ];
    for (const [type, value, error] of cases) {
      expect(() => fromIdlJson(idl, type, value, 'args.x')).toThrow(error);
    }
    const error = (() => {
      try {
        fromIdlJson(idl, defined('escrowParams'), {}, 'args.params');
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(IdlJsonError);
    expect((error as IdlJsonError).path).toMatch(/^args\.params\./);
  });

  it('demet alanlı, generic ve takma ad tipler', () => {
    const idl: Idl = {
      address: PROGRAM_IDS.escrow.toBase58(),
      metadata: { name: 'fixture', version: '0.0.0', spec: '0.1.0' },
      instructions: [],
      types: [
        { name: 'pair', type: { kind: 'struct', fields: ['u8', 'bool'] } },
        { name: 'alias', type: { kind: 'type', alias: 'u8' } },
        { name: 'boxed', generics: [{ kind: 'type', name: 'T' }], type: { kind: 'struct', fields: [] } },
      ],
    };
    expect(() => fromIdlJson(idl, defined('pair'), {})).toThrow(/demet/);
    expect(() => fromIdlJson(idl, defined('alias'), 1)).toThrow(/desteklenmeyen tip türü/);
    expect(() => fromIdlJson(idl, defined('boxed'), {})).toThrow(/generic/);
  });
});
