#!/usr/bin/env node
// Convert a snarkjs Groth16 verification key (JSON) into Rust byte arrays that
// slot directly into groth16-solana's Groth16Verifyingkey struct.
//
// snarkjs JSON layout for BN254:
//   vk_alpha_1     : [x, y, 1]                    (G1, affine + projective z)
//   vk_beta_2      : [[x0,x1], [y0,y1], ["1","0"]] (G2 over Fp2)
//   vk_gamma_2     : same shape as vk_beta_2
//   vk_delta_2     : same shape as vk_beta_2
//   IC             : [[x, y, 1], ...]             (one G1 per public input + 1)
//
// groth16-solana byte layout:
//   G1 -> 64 bytes = x || y (each 32-byte big-endian)
//   G2 -> 128 bytes = x1 || x0 || y1 || y0 (Fp2 components reversed vs snarkjs)
//
// This script prints Rust source that can be pasted into
// programs/verifier/src/groth16_vk.rs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const vkPath = process.argv[2]
  ?? path.resolve(__dirname, '..', 'artifacts', 'payment_vk.json');
const constName = process.argv[3] ?? 'APERTURE_PAYMENT_VK';
const nrInputsConst = process.argv[4] ?? 'PAYMENT_NR_INPUTS';

const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));

const BN254_P = BigInt(
  '21888242871839275222246405745257275088696311157297823662689037894645226208583',
);

function toFieldBytes(decimalString) {
  const n = BigInt(decimalString);
  if (n < 0n || n >= BN254_P) {
    throw new Error(`Field element out of range: ${decimalString}`);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const buf = Buffer.alloc(32);
  Buffer.from(hex, 'hex').copy(buf, 32 - hex.length / 2);
  return Array.from(buf);
}

function encodeG1(point) {
  const [x, y] = point;
  return [...toFieldBytes(x), ...toFieldBytes(y)];
}

function encodeG2(point) {
  // snarkjs: [[x0, x1], [y0, y1], [z0, z1]]
  // groth16-solana expects the Fp2 components in reversed order.
  const [x, y] = point;
  return [
    ...toFieldBytes(x[1]),
    ...toFieldBytes(x[0]),
    ...toFieldBytes(y[1]),
    ...toFieldBytes(y[0]),
  ];
}

function formatByteArray(bytes, name, indent = '    ') {
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(
      indent +
        '    ' +
        bytes
          .slice(i, i + 16)
          .map((b) => b.toString().padStart(3, ' '))
          .join(', ') +
        ',',
    );
  }
  return `${indent}${name}: [\n${rows.join('\n')}\n${indent}],`;
}

function formatIcArray(icBytes, indent = '    ') {
  const inner = icBytes
    .map((point) => {
      const rows = [];
      for (let i = 0; i < point.length; i += 16) {
        rows.push(
          indent +
            '        ' +
            point
              .slice(i, i + 16)
              .map((b) => b.toString().padStart(3, ' '))
              .join(', ') +
            ',',
        );
      }
      return `${indent}    [\n${rows.join('\n')}\n${indent}    ]`;
    })
    .join(',\n');
  return `const ${constName}_IC: [[u8; 64]; ${icBytes.length}] = [\n${inner}\n];`;
}

const alphaBytes = encodeG1(vk.vk_alpha_1);
const betaBytes = encodeG2(vk.vk_beta_2);
const gammaBytes = encodeG2(vk.vk_gamma_2);
const deltaBytes = encodeG2(vk.vk_delta_2);
const icBytes = vk.IC.map(encodeG1);

const nPublic = Number(vk.nPublic);
if (icBytes.length !== nPublic + 1) {
  throw new Error(
    `IC length (${icBytes.length}) does not match nPublic+1 (${nPublic + 1})`,
  );
}

console.log(
  `// Generated from ${path.relative(process.cwd(), vkPath)} — do not edit by hand.`,
);
console.log(`// Regenerate with: node services/prover-service/scripts/extract-vk-rust.mjs`);
console.log('');
console.log(`pub const ${nrInputsConst}: usize = ${nPublic};`);
console.log('');
console.log(formatIcArray(icBytes, ''));
console.log('');
console.log(
  `pub const ${constName}: Groth16Verifyingkey = Groth16Verifyingkey {`,
);
console.log(`    nr_pubinputs: ${nPublic},`);
console.log(formatByteArray(alphaBytes, 'vk_alpha_g1'));
console.log(formatByteArray(betaBytes, 'vk_beta_g2'));
console.log(formatByteArray(gammaBytes, 'vk_gamme_g2'));
console.log(formatByteArray(deltaBytes, 'vk_delta_g2'));
console.log(`    vk_ic: &${constName}_IC,`);
console.log('};');
