// "Devre test vektörleriyle uyumlu": devrenin 14 senaryosunun witness'ı ve commitment'ı bu paketin
// normalizasyonuyla bayt bayt yeniden üretilir (circuits/payment-compliance/test-inputs/).
import { describe, expect, it } from 'vitest';
import { policyCommitmentField } from '../src/policy.js';
import { releaseInputs } from '../src/witness.js';
import { readCircuitJson, SCENARIOS, scenario, testSalts } from './helpers/circuit-world.js';

const salts = testSalts('default policy');

describe('devre test vektörleri', () => {
  for (const { name, overrides } of SCENARIOS) {
    it(name, () => {
      const { policy, paymentCategory, facts } = scenario(overrides);
      expect(releaseInputs(policy, salts, paymentCategory, facts)).toEqual(readCircuitJson(`test-inputs/${name}.json`));
      const expected = readCircuitJson(`test-inputs/${name}.expected.json`);
      expect(String(policyCommitmentField(policy, salts))).toBe(expected.public_signals.policy_commitment);
    });
  }
});
