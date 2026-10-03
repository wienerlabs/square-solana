import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BN254_R } from '@squaresdk/solana-policy';
import { groth16 } from 'snarkjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArtifactError, loadArtifacts, type Artifacts } from '../src/artifacts.js';
import { InvalidWitnessError, createProver, type Prover } from '../src/prover.js';
import {
  ARTIFACT_PATHS,
  MANIFEST,
  SCENARIOS,
  VERIFICATION_KEY,
  flipHex,
  scenario,
  toSnarkjs,
  verifyResponse,
} from './helpers.js';

const decimal = (hex: string) => BigInt(`0x${hex}`).toString();

let artifacts: Artifacts;
let prover: Prover;
beforeAll(async () => {
  artifacts = await loadArtifacts(ARTIFACT_PATHS);
  prover = createProver(artifacts);
});

describe('loadArtifacts', () => {
  it("wasm ve zkey manifest'le eşleşiyor; sürüm zkey'in SHA-256'sı", () => {
    expect(artifacts.version).toBe(MANIFEST.zkey.sha256);
    expect(artifacts.circuit).toBe(MANIFEST.circuit);
    expect(artifacts.verificationKey.nPublic).toBe(13);
  });

  describe('bozuk artefaktta servis açılmaz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prover-artifacts-'));
    const tampered = (source: string, name: string) => {
      const bytes = readFileSync(source);
      bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
      const file = join(dir, name);
      writeFileSync(file, bytes);
      return file;
    };

    it('tek baytı değişmiş zkey', async () => {
      const zkeyPath = tampered(ARTIFACT_PATHS.zkeyPath, 'payment.zkey');
      await expect(loadArtifacts({ ...ARTIFACT_PATHS, zkeyPath })).rejects.toThrow(/zkey manifest'le uyuşmuyor/);
    });

    it('tek baytı değişmiş wasm', async () => {
      const wasmPath = tampered(ARTIFACT_PATHS.wasmPath, 'payment.wasm');
      await expect(loadArtifacts({ ...ARTIFACT_PATHS, wasmPath })).rejects.toThrow(/wasm manifest'le uyuşmuyor/);
    });

    it('manifest yok, bozuk ya da eksik alanlı', async () => {
      await expect(loadArtifacts({ ...ARTIFACT_PATHS, manifestPath: join(dir, 'yok.json') })).rejects.toThrow(
        ArtifactError,
      );
      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{');
      await expect(loadArtifacts({ ...ARTIFACT_PATHS, manifestPath: broken })).rejects.toThrow(/manifest geçersiz/);
      const partial = join(dir, 'partial.json');
      writeFileSync(partial, JSON.stringify({ circuit: MANIFEST.circuit, wasm: MANIFEST.wasm }));
      await expect(loadArtifacts({ ...ARTIFACT_PATHS, manifestPath: partial })).rejects.toThrow(/manifest geçersiz/);
    });

    it('başka bir yerden kopyalanmış doğru dosyalar kabul edilir', async () => {
      const zkeyPath = join(dir, 'copy.zkey');
      copyFileSync(ARTIFACT_PATHS.zkeyPath, zkeyPath);
      await expect(loadArtifacts({ ...ARTIFACT_PATHS, zkeyPath })).resolves.toMatchObject({
        version: artifacts.version,
      });
    });
  });
});

describe('createProver', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    '%s: ispat release anahtarıyla doğrulanıyor, sinyaller devre vektörüyle aynı',
    async (_name, s) => {
      const response = await prover.prove(s.witness);
      expect(response.artifactVersion).toBe(MANIFEST.zkey.sha256);
      expect(response.publicInputs.map(decimal)).toEqual(s.publicSignals);
      expect(await verifyResponse(response)).toBe(true);
    },
  );

  // Aperture tamper-test'inin karşılığı: ispat hem baytlarına hem public sinyallerine bağlı.
  it('tamper: ispatın ya da bir public sinyalin tek değişikliği doğrulamayı düşürür', async () => {
    const response = await prover.prove(scenario('ok_compliant').witness);
    expect(await verifyResponse(response)).toBe(true);
    expect(await verifyResponse({ ...response, proofA: flipHex(response.proofA, 63) })).toBe(false);
    expect(await verifyResponse({ ...response, proofB: flipHex(response.proofB, 200) })).toBe(false);
    expect(await verifyResponse({ ...response, proofC: flipHex(response.proofC, 127) })).toBe(false);
    for (const index of [0, 5, 9]) {
      const publicInputs = response.publicInputs.map((h, i) => (i === index ? flipHex(h, 63) : h));
      expect(await verifyResponse({ ...response, publicInputs })).toBe(false);
    }
    // Ret kodu 0 → 8: ispatı reddedilen bir release'e çevirmek de mümkün değil.
    const { proof, publicSignals } = toSnarkjs(response);
    expect(publicSignals[0]).toBe('0');
    expect(await groth16.verify(VERIFICATION_KEY, ['8', ...publicSignals.slice(1)], proof)).toBe(false);
  });

  describe('devreyi sağlamayan ya da biçimsiz witness reddedilir', () => {
    const base = scenario('ok_compliant').witness;
    const cases: [string, Record<string, string | string[]>][] = [
      ['eksik sinyal', Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'net_amount_in'))],
      ['fazla sinyal', { ...base, extra_signal: '1' }],
      ['dizide eksik eleman', { ...base, token_whitelist: (base.token_whitelist as string[]).slice(1) }],
      ['64 bit aralık denetimi', { ...base, net_amount_in: (2n ** 64n).toString() }],
      ['hex değer', { ...base, net_amount_in: '0x10' }],
      ['negatif değer', { ...base, net_amount_in: '-1' }],
      ['başta sıfır', { ...base, net_amount_in: '025000000' }],
      ['alan dışı değer', { ...base, net_amount_in: BN254_R.toString() }],
    ];
    it.each(cases)('%s', async (_name, witness) => {
      await expect(prover.prove(witness)).rejects.toThrow(InvalidWitnessError);
    });
  });
});
