#!/usr/bin/env node
// Fetch the phase-1 powers of tau the tests prove against, and refuse a file
// whose hash is not the pinned one.
//
// Phase 1 is the universal, circuit-independent half of a Groth16 setup. The
// file below is a real Perpetual Powers of Tau contribution, the same one Arc
// (wienerlabs/square at dc0157f, circuits/scripts/fetch-ptau.mjs) adopted, so
// no part of the test setup is a local stand-in. Adopting it for the release
// key, with its provenance written down, is BC-20; BC-19 only proves with it.
//
// The hash is the trust anchor, not the host: any mirror listed by
// github.com/privacy-ethereum/perpetualpowersoftau serves the same bytes, and
// the file is either the one that hashes to PTAU.sha256 or it is refused. The
// Hermez URL snarkjs still prints now answers 403.
//
// Power 14 is the smallest that fits payment.circom: snarkjs sizes the domain
// as log2(constraints + public outputs) + 1, and 13,495 + 13 needs 2^14.
//
//   node scripts/fetch-ptau.mjs            fetch if missing, then verify
//   node scripts/fetch-ptau.mjs --verify   verify what is already on disk

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PTAU = Object.freeze({
  ceremony: 'Perpetual Powers of Tau',
  contribution: 80,
  file: 'ppot_0080_14.ptau',
  power: 14,
  bytes: 18967698,
  sha256: '3ca1149e9349b22b0ee0649399cfb787677129b7b1189d1899fc0d615d9583db',
  blake2b:
    'a91842802f01b33fd42f5f69c3e49879ae03f0ae1f448b0c151244c9957024bd'
    + '30bf5e3cc999ff2aeb02ebb959124a3a6a3cc20691cb4843a1234a02232072f3',
  url: 'https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_14.ptau',
});

export const ptauPath = () => path.join(ROOT, 'build', PTAU.file);

function digest(algorithm, file) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
}

export function verifyPtau(file = ptauPath()) {
  if (!fs.existsSync(file)) {
    throw new Error(`${path.basename(file)} is not present; run scripts/fetch-ptau.mjs`);
  }
  const bytes = fs.statSync(file).size;
  if (bytes !== PTAU.bytes) {
    throw new Error(`${path.basename(file)} is ${bytes} bytes, expected ${PTAU.bytes}`);
  }
  const sha256 = digest('sha256', file);
  const blake2b = digest('blake2b512', file);
  if (sha256 !== PTAU.sha256 || blake2b !== PTAU.blake2b) {
    throw new Error(
      `${path.basename(file)} is not the pinned file\n`
      + `  sha256  expected ${PTAU.sha256}\n          got      ${sha256}\n`
      + `  blake2b expected ${PTAU.blake2b}\n          got      ${blake2b}`,
    );
  }
  return { file, bytes, sha256, blake2b };
}

async function download(url, destination) {
  process.stdout.write(`fetching ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText} from ${url}; the ceremony repository lists mirrors: `
      + 'https://github.com/privacy-ethereum/perpetualpowersoftau',
    );
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, destination);
}

export async function ensurePtau() {
  const file = ptauPath();
  if (!fs.existsSync(file)) await download(PTAU.url, file);
  return verifyPtau(file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = process.argv.includes('--verify') ? verifyPtau() : await ensurePtau();
    process.stdout.write(
      `${path.relative(process.cwd(), result.file)}\n`
      + `  ${result.bytes} bytes\n  sha256  ${result.sha256}\n  blake2b ${result.blake2b}\n`
      + `  matches ${PTAU.ceremony} contribution ${PTAU.contribution}, power ${PTAU.power}\n`,
    );
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}
