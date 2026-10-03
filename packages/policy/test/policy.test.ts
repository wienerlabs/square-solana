import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BN254_R, categoryField, fieldToBytes32, poseidon } from '../src/fields.js';
import {
  commitmentFromBytes,
  computePolicyCommitment,
  derivePolicySalts,
  generatePolicySecret,
  normalizePolicy,
  policyCommitmentField,
} from '../src/policy.js';
import { scenario, testSalts } from './helpers/circuit-world.js';

const { policy } = scenario({});

describe('politika', () => {
  it('pencere günleri devrenin maske sırasıyla; pencere yoksa sıfırlar', () => {
    expect(normalizePolicy(policy)).toMatchObject({
      timeActive: 1,
      timeDaysBitmask: 0b0011111,
      timeStartHourUtc: 9,
      timeEndHourUtc: 17,
    });
    expect(
      normalizePolicy({ ...policy, timeWindow: { days: ['sunday', 'monday'], startHourUtc: 0, endHourUtc: 23 } })
        .timeDaysBitmask,
    ).toBe(0b1000001);
    expect(normalizePolicy({ ...policy, timeWindow: null })).toMatchObject({
      timeActive: 0,
      timeDaysBitmask: 0,
      timeStartHourUtc: 0,
      timeEndHourUtc: 0,
    });
    expect(normalizePolicy(policy).tokenWhitelist).toHaveLength(10);
    expect(normalizePolicy(policy).allowedCategories).toHaveLength(8);
    expect(() => normalizePolicy({ ...policy, maxPerTx: '-1' })).toThrow();
  });

  it('commitment 32 bayt big-endian; zincir baytlarından geri okunur', () => {
    const salts = testSalts('default policy');
    const bytes = computePolicyCommitment(policy, salts);
    expect(bytes).toHaveLength(32);
    expect(commitmentFromBytes(bytes)).toBe(policyCommitmentField(policy, salts));
    expect(() => policyCommitmentField(policy, salts.slice(0, 7))).toThrow(/8 salt/);
    expect(() => policyCommitmentField(policy, [...salts.slice(0, 7), BN254_R])).toThrow(/alan elemanı/);
  });

  it('salt türetme: deterministik, politika ve sır başına farklı, alan içinde', () => {
    const secret = generatePolicySecret();
    const policyId = randomBytes(32);
    const salts = derivePolicySalts(secret, policyId);
    expect(salts).toHaveLength(8);
    expect(new Set(salts.map(String)).size).toBe(8);
    expect(salts.every((s) => s > 0n && s < BN254_R)).toBe(true);
    expect(derivePolicySalts(secret, policyId)).toEqual(salts);
    expect(derivePolicySalts(secret, randomBytes(32))).not.toEqual(salts);
    expect(derivePolicySalts(generatePolicySecret(), policyId)).not.toEqual(salts);
    expect(() => derivePolicySalts(new Uint8Array(31), policyId)).toThrow(/sır/);
    expect(() => derivePolicySalts(secret, new Uint8Array(33))).toThrow(/policyId/);
  });

  it('alan kodlamaları', () => {
    expect(() => poseidon([])).toThrow(/Poseidon/);
    expect(() => poseidon(Array<bigint>(11).fill(1n))).toThrow(/Poseidon/);
    expect(() => categoryField('')).toThrow(/kategori/);
    expect(() => categoryField('x'.repeat(33))).toThrow(/kategori/);
    expect(() => fieldToBytes32(BN254_R)).toThrow(/alan/);
  });
});
