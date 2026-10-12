// The public phase-2 ceremony (BC-38). First the beacon's trust anchor: the drand chain is recomputed from the
// parameters it serves and a real quicknet round verifies against the pinned group key. Then a whole ceremony
// on the release circuit and the pinned PPoT file: two contributions whose entropy is typed into snarkjs, the
// announced round closing the chain, and a third party's check of the result, with every tampered record
// failing. The run is given its clock and its drand source so the recorded round (fixtures/) can close it; the
// keys, the hashes and the round are all real. The contributors are labelled as tests and live in a temporary
// directory: nothing here is a ceremony anyone could publish.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import {
  beaconProblems,
  ceremony,
  chainHashOf,
  DRAND,
  ITERATIONS_EXP,
  keyName,
  quicknetProblems,
  readChain,
  roundAt,
  timeOfRound,
  transcriptProblems,
  verifyChain,
  verifyDrandSignature,
} from '../scripts/ceremony.mjs';
import { ensurePtau, verifyPtau } from '../scripts/fetch-ptau.mjs';
import { phase2Record, readCeremony } from '../scripts/release-artifacts.mjs';
import { buildInput } from '../scripts/release-input.mjs';
import { BUILD, isBuilt, prerequisite, wasmPath } from './helpers/witness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '..', 'artifacts');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const INFO = fixture('drand-quicknet-info.json');
const ROUND = fixture('drand-quicknet-round-32832327.json');
const R1CS = path.join(BUILD, 'payment.r1cs');
const ANNOUNCEMENT = 'https://github.com/wienerlabs/square-solana/issues/92';

const havePtau = (() => {
  try {
    verifyPtau();
    return true;
  } catch {
    return false;
  }
})();
const skip = prerequisite(
  (!isBuilt('payment') && 'run `npm run build` first') || (!havePtau && 'run `npm run fetch-ptau` first'),
);

const flip = (hex, at) => `${hex.slice(0, at)}${((parseInt(hex[at], 16) + 1) % 16).toString(16)}${hex.slice(at + 1)}`;

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('the beacon counts on quicknet, recomputed from the parameters drand serves', () => {
  assert.equal(chainHashOf(INFO), DRAND.chainHash);
  assert.deepEqual(quicknetProblems(INFO), []);
  assert.ok(quicknetProblems({ ...INFO, period: 30 }).length >= 2);
  assert.ok(quicknetProblems({ ...INFO, public_key: flip(INFO.public_key, 10) }).some((p) => p.includes('pinned')));
});

test("a round's signature verifies for that round only, and a corrupted one is invalid", async () => {
  assert.equal(await verifyDrandSignature(ROUND.round, ROUND.signature), true);
  assert.equal(await verifyDrandSignature(ROUND.round + 1, ROUND.signature), false);
  assert.equal(await verifyDrandSignature(ROUND.round, flip(ROUND.signature, 20)), false);
});

test('a round lands on the three-second schedule from genesis', () => {
  assert.equal(roundAt(DRAND.genesis), 1);
  const at = timeOfRound(ROUND.round);
  assert.equal(roundAt(at), ROUND.round);
  assert.equal(roundAt(at + DRAND.period - 1), ROUND.round);
  assert.equal(roundAt(at + DRAND.period), ROUND.round + 1);
});

test('the release pipeline keeps the development record while there is no ceremony', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'manifest.json'), 'utf8'));
  if (manifest.phase2.kind !== 'development') return;
  assert.deepEqual(phase2Record(manifest.phase2.contributions, null), manifest.phase2);
  assert.throws(() => phase2Record([...manifest.phase2.contributions, ...manifest.phase2.contributions], null));
});

// --------------------------------------------------------------- a whole ceremony

let dir;
let now;
let ptau;
const run = (overrides = {}) =>
  ceremony({
    dir,
    clock: () => now,
    drand: { info: async () => INFO, round: async () => ROUND },
    r1cs: R1CS,
    ptau,
    stdio: ['pipe', 'ignore', 'inherit'],
    // The entropy snarkjs asks for: typed on its stdin, never an argument.
    onContribute: (child) => child.stdin.end(`${crypto.randomBytes(32).toString('hex')}\n`),
    out: () => {},
    ...overrides,
  });
const transcript = () => JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
const landsAt = () => timeOfRound(ROUND.round) * 1000;

before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-ceremony-'));
  ({ file: ptau } = await ensurePtau());
  now = landsAt() - 3_600_000;
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test(
  'init starts from the circuit and the phase-1 file, and only with a beacon round still to come',
  { skip },
  async () => {
    now = landsAt() + 1_000;
    await assert.rejects(run().init({ beaconRound: ROUND.round, announcement: ANNOUNCEMENT }), /not in the future/);
    now = landsAt() - 3_600_000;
    await assert.rejects(run().init({ beaconRound: ROUND.round }), /--announcement/);
    await run().init({ beaconRound: ROUND.round, announcement: ANNOUNCEMENT });
    const t = transcript();
    assert.deepEqual(t.beacon, {
      source: 'drand quicknet',
      chainHash: DRAND.chainHash,
      round: ROUND.round,
      landsAt: new Date(landsAt()).toISOString(),
      announcement: ANNOUNCEMENT,
    });
    assert.equal(t.phase1.sha256, '3ca1149e9349b22b0ee0649399cfb787677129b7b1189d1899fc0d615d9583db');
    assert.match(t.circuit.circuitHash, /^[0-9a-f]{128}$/);
    assert.deepEqual(t.contributions, []);
    assert.equal(
      t.start.zkey.sha256,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(dir, keyName(0))))
        .digest('hex'),
    );
    await assert.rejects(run().init({ beaconRound: ROUND.round, announcement: ANNOUNCEMENT }), /already exists/);
  },
);

test(
  'each contribution is recorded with the hash snarkjs printed and the key it wrote',
  { skip, timeout: 300_000 },
  async () => {
    await assert.rejects(run().beacon(), /no contributions yet/);
    now += 600_000;
    await run().contribute('test contributor 1');
    now += 600_000;
    await run().contribute('test contributor 2');
    await assert.rejects(run().beacon(), /wait for it/);
    const t = transcript();
    assert.deepEqual(
      t.contributions.map(({ index, name }) => [index, name]),
      [
        [1, 'test contributor 1'],
        [2, 'test contributor 2'],
      ],
    );
    for (const entry of t.contributions) {
      assert.match(entry.hash, /^[0-9a-f]{128}$/);
      const key = fs.readFileSync(path.join(dir, keyName(entry.index)));
      assert.equal(entry.zkey.sha256, crypto.createHash('sha256').update(key).digest('hex'));
    }
    assert.notEqual(t.contributions[0].hash, t.contributions[1].hash);
    const chain = await run().verify();
    assert.equal(chain.contributions.length, 2);
  },
);

test('a swapped key, or one the transcript does not record, stops the next step', { skip }, async () => {
  const tip = path.join(dir, keyName(2));
  const held = fs.readFileSync(tip);
  fs.copyFileSync(path.join(dir, keyName(1)), tip);
  await assert.rejects(run().contribute('test contributor 3'), /is not the key that was published/);
  fs.writeFileSync(tip, held);
  // A contributor may use the coordinator's published r1cs instead of compiling; it has to be the ceremony's.
  const otherCircuit = path.join(dir, 'other.r1cs');
  const r1cs = fs.readFileSync(R1CS);
  r1cs[r1cs.length - 1] ^= 1;
  fs.writeFileSync(otherCircuit, r1cs);
  await assert.rejects(run({ r1cs: otherCircuit }).contribute('test contributor 3'), /the ceremony runs on/);
  fs.rmSync(otherCircuit);
  const ahead = path.join(dir, keyName(3));
  fs.copyFileSync(tip, ahead);
  now = landsAt() + 30_000;
  await assert.rejects(run().beacon(), /ahead of the transcript/);
  fs.rmSync(ahead);
});

test('contributions close when the announced round lands', { skip }, async () => {
  await assert.rejects(run().contribute('test contributor 3'), /contributions are closed/);
  assert.equal(transcript().contributions.length, 2);
});

test('the beacon is refused from a chain that is not quicknet, or a round that does not verify', { skip }, async () => {
  const wrongChain = run({ drand: { info: async () => ({ ...INFO, period: 30 }), round: async () => ROUND } });
  await assert.rejects(wrongChain.beacon(), /did not serve the announced chain/);
  const forged = run({
    drand: { info: async () => INFO, round: async () => ({ ...ROUND, signature: flip(ROUND.signature, 20) }) },
  });
  await assert.rejects(forged.beacon(), /does not verify against the pinned quicknet key/);
  const other = run({ drand: { info: async () => INFO, round: async () => ({ ...ROUND, round: ROUND.round + 1 }) } });
  await assert.rejects(other.beacon(), /the announced round is/);
  assert.equal(transcript().closing, null);
});

test(
  'the announced round closes the chain, with its signature as the beacon value',
  { skip, timeout: 120_000 },
  async () => {
    const closing = await run().beacon();
    assert.equal(closing.signature, ROUND.signature);
    assert.equal(closing.iterationsExp, ITERATIONS_EXP);
    const chain = await readChain(path.join(dir, 'payment_final.zkey'), { r1cs: R1CS, ptau });
    assert.equal(chain.contributions.length, 3);
    assert.deepEqual(chain.contributions[2].beacon, { value: ROUND.signature, iterationsExp: ITERATIONS_EXP });
    assert.equal(chain.contributions[2].name, `drand quicknet round ${ROUND.round}`);
    await assert.rejects(run().beacon(), /already been applied/);
    await assert.rejects(run().contribute('test contributor 3'), /closed/);
  },
);

test(
  'a third party verifies the whole ceremony, and every tampered record fails',
  { skip, timeout: 180_000 },
  async () => {
    const finalKey = path.join(dir, 'payment_final.zkey');
    const vk = path.join(dir, 'verification_key.json');
    fs.writeFileSync(vk, `${JSON.stringify(await snarkjs.zKey.exportVerificationKey(finalKey), null, 2)}\n`);
    const results = await verifyChain({
      transcript: path.join(dir, 'transcript.json'),
      zkey: finalKey,
      r1cs: R1CS,
      ptau,
      vk,
      compile: false,
      offline: true,
      manifest: false,
    });
    assert.deepEqual(
      results.map(({ check, ok, problems }) => [check, ok, problems]),
      ['phase-1 file', 'circuit', 'final key', 'contributions', 'beacon', 'verifying key'].map((check) => [
        check,
        true,
        [],
      ]),
    );

    const chain = await readChain(finalKey, { r1cs: R1CS, ptau });
    const t = transcript();
    assert.deepEqual(transcriptProblems(t, chain), []);
    const tampered = (change) => {
      const copy = structuredClone(t);
      change(copy);
      return copy;
    };
    const renamed = transcriptProblems(
      tampered((c) => (c.contributions[0].name = 'someone else')),
      chain,
    );
    assert.ok(renamed.some((p) => p.startsWith('contribution 1: the key names')));
    const rehashed = transcriptProblems(
      tampered((c) => (c.contributions[1].hash = flip(c.contributions[1].hash, 5))),
      chain,
    );
    assert.ok(rehashed.some((p) => p.startsWith('contribution 2: the key holds hash')));
    const dropped = transcriptProblems(
      tampered((c) => c.contributions.splice(1, 1)),
      chain,
    );
    assert.ok(dropped.some((p) => p.includes('the key holds 3 contributions, the transcript records 2')));
    const reseeded = transcriptProblems(
      tampered((c) => (c.closing.signature = flip(c.closing.signature, 7))),
      chain,
    );
    assert.ok(reseeded.some((p) => p.includes("beacon value is not the drand round's signature")));

    assert.deepEqual(await beaconProblems(t, ROUND), []);
    const late = await beaconProblems(
      tampered((c) => (c.contributions[1].at = new Date(landsAt() + 1_000).toISOString())),
      ROUND,
    );
    assert.ok(late.some((p) => p.includes('not after the last contribution')));
    const moved = await beaconProblems(
      tampered((c) => (c.beacon.round = ROUND.round - 1)),
      ROUND,
    );
    assert.ok(moved.some((p) => p.includes('the announced round is')));
  },
);

test(
  'the release pipeline records the closed key from its transcript, and refuses one that disagrees',
  { skip },
  async () => {
    const chain = await readChain(path.join(dir, 'payment_final.zkey'), { r1cs: R1CS, ptau });
    const contributions = chain.contributions.map(({ index, name, hash }) => ({ index, name, hash }));
    const closed = transcript();
    closed.final = { zkey: { sha256: closed.closing.zkey.sha256 }, verificationKey: { sha256: '0'.repeat(64) } };
    const file = path.join(dir, 'published-transcript.json');
    fs.writeFileSync(file, `${JSON.stringify(closed, null, 2)}\n`);
    const record = phase2Record(contributions, readCeremony(file));
    assert.equal(record.kind, 'ceremony');
    assert.equal(
      record.assurance,
      `public ceremony: 2 contributions and drand quicknet round ${ROUND.round} as the beacon (BC-38)`,
    );
    assert.deepEqual(record.beacon, { source: 'drand quicknet', round: ROUND.round, signature: ROUND.signature });
    assert.equal(record.transcript.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    assert.deepEqual(record.contributions, contributions);
    closed.contributions[0].name = 'someone else';
    fs.writeFileSync(file, `${JSON.stringify(closed, null, 2)}\n`);
    assert.throws(() => phase2Record(contributions, readCeremony(file)), /tören transcript'iyle aynı değil/);
  },
);

test(
  'a proof made with the development key does not verify under the ceremony key',
  { skip, timeout: 120_000 },
  async () => {
    const finalKey = path.join(dir, 'payment_final.zkey');
    const ceremonyVk = await snarkjs.zKey.exportVerificationKey(finalKey);
    const developmentVk = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'verification_key.json'), 'utf8'));
    const input = await buildInput();
    const dev = await snarkjs.groth16.fullProve(input, wasmPath('payment'), path.join(ARTIFACTS, 'payment.zkey'));
    assert.equal(await snarkjs.groth16.verify(developmentVk, dev.publicSignals, dev.proof), true);
    assert.equal(await snarkjs.groth16.verify(ceremonyVk, dev.publicSignals, dev.proof), false);
    const closed = await snarkjs.groth16.fullProve(input, wasmPath('payment'), finalKey);
    assert.equal(await snarkjs.groth16.verify(ceremonyVk, closed.publicSignals, closed.proof), true);
  },
);
