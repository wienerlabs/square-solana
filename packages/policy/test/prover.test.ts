// "In-process ispat snarkjs doğrulamasından geçiyor": release anahtarıyla gerçek ispat üretilir,
// groth16-solana düzenine kodlanır, geri çözülüp release doğrulama anahtarıyla doğrulanır.
import { afterAll, describe, expect, it } from 'vitest';
import { PUBLIC_SIGNAL_NAMES } from './helpers/signals.js';
import { localProver, manifest, verify } from './helpers/artifacts.js';
import { readCircuitJson, scenario, testSalts, world } from './helpers/circuit-world.js';
import { releaseInputs } from '../src/witness.js';
import { encodeProof } from '../src/prover.js';

const salts = testSalts('default policy');

function witnessFor(name: string, overrides: Parameters<typeof scenario>[0]) {
  const { policy, paymentCategory, facts } = scenario(overrides);
  return { name, witness: { ...facts, inputs: releaseInputs(policy, salts, paymentCategory, facts) } };
}

afterAll(async () => {
  const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128;
  await curve?.terminate();
});

describe('createLocalProver', () => {
  for (const { name, witness } of [
    witnessFor('ok_compliant', {}),
    witnessFor('bad_payee_blocked', { payee: world.blockedWallet }),
  ]) {
    it(`${name}: ispat release anahtarıyla doğrulanıyor`, async () => {
      const response = await localProver.prove(witness);
      expect(response.artifactVersion).toBe(manifest.zkey.sha256);
      expect(response.publicInputs).toHaveLength(13);
      expect(await verify(response)).toBe(true);
      if (name === 'bad_payee_blocked') expect(BigInt(`0x${response.publicInputs[0]!}`)).toBe(8n);
      if (name === 'ok_compliant') {
        const expected = readCircuitJson('test-inputs/ok_compliant.expected.json').public_signals;
        const signals = response.publicInputs.map((h) => BigInt(`0x${h}`).toString());
        expect(Object.fromEntries(PUBLIC_SIGNAL_NAMES.map((n, i) => [n, signals[i]]))).toEqual(expected);
      }
    });
  }

  it('değiştirilmiş ispat ve sinyal reddedilir', async () => {
    const response = await localProver.prove(witnessFor('ok_compliant', {}).witness);
    const flip = (hex: string, at: number) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
    expect(await verify({ ...response, proofC: flip(response.proofC, 127) })).toBe(false);
    const inputs = [...response.publicInputs];
    inputs[5] = flip(inputs[5]!, 63);
    expect(await verify({ ...response, publicInputs: inputs })).toBe(false);
  });

  it('kodlama alan dışı değerleri reddeder', () => {
    const q = '21888242871839275222246405745257275088696311157297823662689037894645226208583';
    const proof = {
      pi_a: ['1', '2'],
      pi_b: [
        ['1', '2'],
        ['3', '4'],
      ],
      pi_c: ['5', '6'],
    };
    expect(() => encodeProof({ ...proof, pi_c: [q, '1'] }, ['0'])).toThrow(/taban alanı/);
    expect(() => encodeProof(proof, [q])).toThrow(/skaler alan/);
  });
});
