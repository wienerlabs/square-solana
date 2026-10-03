import type { Idl } from '@coral-xyz/anchor';
import { describe, expect, it } from 'vitest';
import { idlBytesConstant } from '../src/idl-constants.js';
import { SQUARE_IDLS } from '../src/programs.js';

const idlWith = (constants: { name: string; type: string; value: string }[]) =>
  ({ ...(SQUARE_IDLS.escrow as unknown as Idl), constants }) as unknown as Idl;

describe('idlBytesConstant', () => {
  it('SNAKE_CASE ve camelCase adla aynı sabite çözülür', () => {
    const idl = SQUARE_IDLS.escrow as unknown as Idl;
    expect(Buffer.from(idlBytesConstant(idl, 'JOB_SEED')).toString()).toBe('job');
    expect(Buffer.from(idlBytesConstant(idl, 'jobSeed')).toString()).toBe('job');
  });

  it('eksik, bytes olmayan ya da bozuk sabiti reddeder', () => {
    expect(() => idlBytesConstant(idlWith([]), 'JOB_SEED')).toThrow(/sabiti yok/);
    expect(() => idlBytesConstant(idlWith([{ name: 'JOB_SEED', type: 'u8', value: '3' }]), 'JOB_SEED')).toThrow(
      /bytes değil/,
    );
    expect(() =>
      idlBytesConstant(idlWith([{ name: 'JOB_SEED', type: 'bytes', value: '[1, 256]' }]), 'JOB_SEED'),
    ).toThrow(/bayt dizisi/);
    expect(() => idlBytesConstant(idlWith([{ name: 'JOB_SEED', type: 'bytes', value: '"x"' }]), 'JOB_SEED')).toThrow(
      /bayt dizisi/,
    );
  });
});
