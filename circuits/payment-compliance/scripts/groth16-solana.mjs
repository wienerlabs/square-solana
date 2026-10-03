// snarkjs çıktısını groth16-solana'nın bayt düzenine çevirir ve doğrulama anahtarı / test
// vektörü için Rust kaynağı üretir. Aperture prover-service'in extract-vk-rust.mjs ve
// src/convert.js'inden (MIT) alındı (BC-20).
//
//   G1 -> 64 bayt  = x || y            (her biri 32 bayt big-endian)
//   G2 -> 128 bayt = x1 || x0 || y1 || y0  (Fp2 bileşenleri snarkjs'e göre ters)
//   proof_a, groth16-solana'nın pairing denkleminde eksiyle girer: y yerine p - y.

export const BN254_P = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');

export function fieldBytes(decimal) {
  const n = BigInt(decimal);
  if (n < 0n || n >= BN254_P) throw new Error(`alan elemanı aralık dışında: ${decimal}`);
  return Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
}

export const encodeG1 = ([x, y]) => [...fieldBytes(x), ...fieldBytes(y)];
export const encodeG2 = ([x, y]) => [...fieldBytes(x[1]), ...fieldBytes(x[0]), ...fieldBytes(y[1]), ...fieldBytes(y[0])];

/** snarkjs Groth16 ispatı ve public sinyalleri → groth16-solana girdileri (bayt dizileri). */
export function encodeProof(proof, publicSignals) {
  const negY = ((BN254_P - BigInt(proof.pi_a[1])) % BN254_P).toString();
  return {
    proofA: [...fieldBytes(proof.pi_a[0]), ...fieldBytes(negY)],
    proofB: encodeG2(proof.pi_b),
    proofC: encodeG1(proof.pi_c),
    publicInputs: publicSignals.map(fieldBytes),
  };
}

function byteRows(bytes, indent) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(`${indent}${bytes.slice(i, i + 16).map((b) => String(b).padStart(3, ' ')).join(', ')},`);
  }
  return rows.join('\n');
}

const byteArray = (name, bytes, indent) => `${indent}${name}: [\n${byteRows(bytes, `${indent}    `)}\n${indent}],`;

/**
 * snarkjs doğrulama anahtarı (JSON) → `Groth16Verifyingkey` sabiti. `header` dosyanın başına
 * yorum olarak eklenir.
 */
export function renderVerifyingKey(vk, { constName, nrInputsConst, header }) {
  const nPublic = Number(vk.nPublic);
  const ic = vk.IC.map(encodeG1);
  if (ic.length !== nPublic + 1) throw new Error(`IC uzunluğu ${ic.length}, nPublic + 1 = ${nPublic + 1} bekleniyordu`);
  const icItems = ic.map((point) => `    [\n${byteRows(point, '        ')}\n    ]`).join(',\n');
  return [
    ...header.map((line) => (line ? `// ${line}` : '//')),
    '',
    'use groth16_solana::groth16::Groth16Verifyingkey;',
    '',
    `pub const ${nrInputsConst}: usize = ${nPublic};`,
    '',
    `const ${constName}_IC: [[u8; 64]; ${ic.length}] = [\n${icItems}\n];`,
    '',
    `pub const ${constName}: Groth16Verifyingkey = Groth16Verifyingkey {`,
    `    nr_pubinputs: ${nPublic},`,
    byteArray('vk_alpha_g1', encodeG1(vk.vk_alpha_1), '    '),
    byteArray('vk_beta_g2', encodeG2(vk.vk_beta_2), '    '),
    byteArray('vk_gamme_g2', encodeG2(vk.vk_gamma_2), '    '),
    byteArray('vk_delta_g2', encodeG2(vk.vk_delta_2), '    '),
    `    vk_ic: &${constName}_IC,`,
    '};',
    '',
  ].join('\n');
}

const constArray = (name, type, bytes) => `pub const ${name}: ${type} = [\n${byteRows(bytes, '    ')}\n];`;

/** Gerçek bir ispatın groth16-solana kodlaması → Rust test vektörü sabitleri. */
export function renderProofVector(encoded, { prefix, header }) {
  const inputs = encoded.publicInputs.map((bytes) => `    [\n${byteRows(bytes, '        ')}\n    ]`).join(',\n');
  return [
    ...header.map((line) => (line ? `// ${line}` : '//')),
    '',
    constArray(`${prefix}_PROOF_A`, '[u8; 64]', encoded.proofA),
    '',
    constArray(`${prefix}_PROOF_B`, '[u8; 128]', encoded.proofB),
    '',
    constArray(`${prefix}_PROOF_C`, '[u8; 64]', encoded.proofC),
    '',
    `pub const ${prefix}_PUBLIC_INPUTS: [[u8; 32]; ${encoded.publicInputs.length}] = [\n${inputs}\n];`,
    '',
  ].join('\n');
}
