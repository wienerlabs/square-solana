// A Groth16 key for the tests, built on the pinned Perpetual Powers of Tau file
// (scripts/fetch-ptau.mjs) with one phase-2 contribution of fresh random
// entropy.
//
// It is a test key: built locally, never committed (.gitignore covers *.zkey
// and *_vk.json), and thrown away whenever payment.r1cs changes. Nothing on
// chain is keyed to it. The development key and its artefact pipeline are
// BC-20; the public phase-2 ceremony is BC-38.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as snarkjs from 'snarkjs';
import { ensurePtau } from '../../scripts/fetch-ptau.mjs';
import { BUILD } from './witness.mjs';

const R1CS = path.join(BUILD, 'payment.r1cs');
const ZKEY = path.join(BUILD, 'payment_test.zkey');
const VK = path.join(BUILD, 'payment_test_vk.json');

const newer = (a, b) => fs.existsSync(a) && fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs;

export async function ensureTestKey() {
  if (!(newer(ZKEY, R1CS) && newer(VK, ZKEY))) {
    const { file: ptau } = await ensurePtau();
    const initial = path.join(BUILD, 'payment_test_0.zkey');
    await snarkjs.zKey.newZKey(R1CS, ptau, initial);
    await snarkjs.zKey.contribute(initial, ZKEY, 'BC-19 test key (not for deployment)', crypto.randomBytes(64).toString('hex'));
    fs.rmSync(initial);
    fs.writeFileSync(VK, JSON.stringify(await snarkjs.zKey.exportVerificationKey(ZKEY), null, 1));
  }
  return { zkey: ZKEY, vk: JSON.parse(fs.readFileSync(VK, 'utf8')) };
}
