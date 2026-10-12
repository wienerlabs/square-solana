#!/usr/bin/env node
// Release artefakt pipeline'ı (BC-20): devre → r1cs / wasm, phase-1 PPoT + dev phase-2 → zkey,
// zkey → doğrulama anahtarı → square_verifier'daki Rust sabiti.
//
//   node scripts/release-artifacts.mjs check   (varsayılan) Temiz ortamda her şeyi yeniden üretip
//       commit'lenmiş hâliyle karşılaştırır: ptau hash'i, devre (circom sürümü, r1cs ve wasm
//       hash'leri), zkey'in bu r1cs ve ptau'dan türediği (snarkjs zkey verify), katkı kaydı,
//       zkey'den çıkarılan doğrulama anahtarı, Rust sabiti ve manifest. Bir fark hata verir.
//   node scripts/release-artifacts.mjs setup   Tek seferlik dev phase-2: yeni zkey üretir
//       (entropi işletim sisteminden, hiçbir yere yazılmaz), ardından `write`. Devre değişince
//       çalıştırılır; doğrulama anahtarı değişir.
//   node scripts/release-artifacts.mjs write   Mevcut zkey'den doğrulama anahtarını, Rust
//       dosyalarını ve manifest'i yeniden yazar.
//
// Phase-2'nin kaydı iki türlüdür. `artifacts/ceremony/transcript.json` yoksa geliştirme anahtarıdır: tek katkı,
// kamusal tören değil, güvence iddiası yok (README → Disclosure). Varsa zkey kamusal törenin (BC-38,
// `scripts/ceremony.mjs`) son anahtarıdır; katkıları ve beacon'ı transcript'le birebir aynı olmalıdır.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { ensurePtau, PTAU } from './fetch-ptau.mjs';
import { encodeProof, renderProofVector, renderVerifyingKey } from './groth16-solana.mjs';
import { buildInput } from './release-input.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');
const BUILD = path.join(ROOT, 'build');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const CIRCOM = process.env.CIRCOM || 'circom';

const FILES = Object.freeze({
  r1cs: path.join(BUILD, 'payment.r1cs'),
  wasm: path.join(BUILD, 'payment_js', 'payment.wasm'),
  zkey: path.join(ARTIFACTS, 'payment.zkey'),
  vk: path.join(ARTIFACTS, 'verification_key.json'),
  manifest: path.join(ARTIFACTS, 'manifest.json'),
  rustVk: path.join(REPO, 'programs', 'square-verifier', 'src', 'release_vk.rs'),
  rustVector: path.join(REPO, 'programs', 'square-verifier', 'src', 'release_vk_vector.rs'),
  ceremonyTranscript: path.join(ARTIFACTS, 'ceremony', 'transcript.json'),
});

// snarkjs katkı adını 64 bayta keser.
const CONTRIBUTION_NAME = 'Square BC-20 dev phase-2 (single contribution, not a ceremony)';
const VK_CONST = 'SQUARE_RELEASE_VK';
const NR_INPUTS_CONST = 'RELEASE_NR_INPUTS';

const rel = (file) => path.relative(REPO, file);
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function circomVersion() {
  const result = spawnSync(CIRCOM, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${CIRCOM} bulunamadı; circom 2.2.3 kurun ya da CIRCOM ayarlayın`);
  return result.stdout.trim().replace(/^circom compiler /, '');
}

function compile() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`devre derlenemedi:\n${result.stdout}${result.stderr}`);
}

/** snarkjs'in zkey doğrulama günlüğünü toplar; katkı adı ve hash'i buradan okunur. */
function captureLogger() {
  const lines = [];
  const push = (...args) => lines.push(args.join(' '));
  return { lines, logger: { info: push, warn: push, error: push, debug: () => {} } };
}

const compact = (text) => text.replace(/\s+/g, '');

/** snarkjs her katkıyı tek kayıtta yazar: "contribution #N <ad>:\n\t\t<hash, 4 satır>"; sondan başa yazar. */
function contributionsFrom(lines) {
  return lines
    .flatMap((line) => {
      const match = line.match(/^contribution #(\d+) (.*):\n([\s\S]+)$/);
      return match ? [{ index: Number(match[1]), name: match[2], hash: compact(match[3]) }] : [];
    })
    .sort((a, b) => a.index - b.index);
}

/** Törenin yayımlanmış transcript'i ve SHA-256'sı; tören yapılmadıysa null. */
export function readCeremony(file = FILES.ceremonyTranscript) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file);
  return { transcript: JSON.parse(text.toString('utf8')), sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

/**
 * Manifest'in phase-2 kaydı, zkey'in katkılarından. Tören yoksa tek katkılı dev phase-2 beklenir; varsa katkılar
 * transcript'in katılımcıları ve sonda drand beacon'ıdır (ad ve hash, sırayla). Uymayan kayıt hatadır.
 */
export function phase2Record(contributions, ceremony) {
  if (!ceremony) {
    if (contributions.length !== 1 || contributions[0].name !== CONTRIBUTION_NAME || !/^[0-9a-f]{128}$/.test(contributions[0].hash)) {
      throw new Error(`beklenmeyen phase-2 katkı kaydı: ${JSON.stringify(contributions)}`);
    }
    return { kind: 'development', assurance: 'none: single contribution, not a public ceremony (BC-38)', contributions };
  }
  const { transcript } = ceremony;
  if (!transcript.closing || !transcript.final) throw new Error('tören transcript\'i kapanmamış: beacon ve final kaydı yok');
  const round = transcript.beacon.round;
  const expected = [
    ...transcript.contributions.map(({ name, hash }) => ({ name, hash })),
    { name: `drand quicknet round ${round}`, hash: transcript.closing.hash },
  ];
  const held = contributions.map(({ name, hash }) => ({ name, hash }));
  if (JSON.stringify(held) !== JSON.stringify(expected)) {
    throw new Error(`zkey'in katkıları tören transcript'iyle aynı değil:\n  zkey       ${JSON.stringify(held)}\n  transcript ${JSON.stringify(expected)}`);
  }
  return {
    kind: 'ceremony',
    assurance: `public ceremony: ${transcript.contributions.length} contributions and drand quicknet round ${round} as the beacon (BC-38)`,
    transcript: { file: rel(FILES.ceremonyTranscript), sha256: ceremony.sha256 },
    beacon: { source: 'drand quicknet', round, signature: transcript.closing.signature },
    contributions,
  };
}

function circuitHashFrom(lines) {
  const match = lines.map((line) => line.match(/^Circuit hash: \n([\s\S]+)$/)).find(Boolean);
  if (!match) throw new Error('snarkjs devre hash\'ini yazmadı');
  return compact(match[1]);
}

async function verifyZkey(ptauFile) {
  const { lines, logger } = captureLogger();
  const ok = await snarkjs.zKey.verifyFromR1cs(FILES.r1cs, ptauFile, FILES.zkey, logger);
  if (!ok) throw new Error(`${rel(FILES.zkey)} bu r1cs ve ptau'dan türemiyor:\n${lines.join('\n')}`);
  return { circuitHash: circuitHashFrom(lines), contributions: contributionsFrom(lines) };
}

function rustHeader(zkeySha, phase2) {
  const phase2Lines =
    phase2.kind === 'ceremony'
      ? [
          `Phase 2: ${phase2.assurance};`,
          `  transcript ${phase2.transcript.file}, sha256 ${phase2.transcript.sha256}.`,
        ]
      : [
          'Phase 2: DEVELOPMENT ONLY. A single contribution, not a public ceremony; no security assurance',
          '  is claimed (circuits/payment-compliance/README.md, Disclosure). Public ceremony: BC-38.',
        ];
  return [
    'Generated by circuits/payment-compliance/scripts/release-artifacts.mjs — do not edit by hand.',
    '',
    'Release circuit: circuits/payment-compliance/payment.circom, 13 public signals in the order of',
    'docs/design/release-circuit.md §2.',
    `Phase 1: ${PTAU.ceremony}, contribution ${PTAU.contribution}, power ${PTAU.power}`,
    `  (${PTAU.file}, sha256 ${PTAU.sha256}).`,
    ...phase2Lines,
    `zkey: circuits/payment-compliance/artifacts/payment.zkey, sha256 ${zkeySha}.`,
  ];
}

async function renderOutputs(ptauFile, { withVector, phase2 }) {
  const vk = await snarkjs.zKey.exportVerificationKey(FILES.zkey);
  const zkeySha = sha256(FILES.zkey);
  const outputs = {
    [FILES.vk]: json(vk),
    [FILES.rustVk]: renderVerifyingKey(vk, {
      constName: VK_CONST,
      nrInputsConst: NR_INPUTS_CONST,
      header: rustHeader(zkeySha, phase2),
    }),
  };
  if (withVector) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(await buildInput(), FILES.wasm, FILES.zkey);
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error('test vektörü ispatı doğrulanmadı');
    outputs[FILES.rustVector] = renderProofVector(encodeProof(proof, publicSignals), {
      prefix: 'RELEASE',
      header: [
        'Generated by circuits/payment-compliance/scripts/release-artifacts.mjs — do not edit by hand.',
        `A real Groth16 proof under ${VK_CONST} for the default compliant release input of`,
        'circuits/payment-compliance/scripts/release-input.mjs (test fixture), in groth16-solana encoding.',
      ],
    });
  }
  return { vk, zkeySha, outputs };
}

function manifest({ circom, circuitHash, phase2, zkeySha, vkText, rustText }) {
  return {
    circuit: 'circuits/payment-compliance/payment.circom',
    circom,
    snarkjs: JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'snarkjs', 'package.json'), 'utf8')).version,
    /** snarkjs'in r1cs'ten hesapladığı devre hash'i (zkey içinde de kayıtlı). */
    circuitHash,
    r1cs: { sha256: sha256(FILES.r1cs) },
    wasm: { sha256: sha256(FILES.wasm) },
    phase1: { ...PTAU },
    phase2,
    zkey: { file: rel(FILES.zkey), bytes: fs.statSync(FILES.zkey).size, sha256: zkeySha },
    verificationKey: { file: rel(FILES.vk), sha256: crypto.createHash('sha256').update(vkText).digest('hex') },
    rust: { file: rel(FILES.rustVk), sha256: crypto.createHash('sha256').update(rustText).digest('hex') },
  };
}

async function write({ withVector }) {
  const { file: ptauFile } = await ensurePtau();
  compile();
  const circom = circomVersion();
  const { circuitHash, contributions } = await verifyZkey(ptauFile);
  const phase2 = phase2Record(contributions, readCeremony());
  const { zkeySha, outputs } = await renderOutputs(ptauFile, { withVector, phase2 });
  for (const [file, text] of Object.entries(outputs)) fs.writeFileSync(file, text);
  const record = manifest({ circom, circuitHash, phase2, zkeySha, vkText: outputs[FILES.vk], rustText: outputs[FILES.rustVk] });
  fs.writeFileSync(FILES.manifest, json(record));
  for (const file of [...Object.keys(outputs), FILES.manifest]) process.stdout.write(`wrote ${rel(file)}\n`);
}

async function setup() {
  if (readCeremony()) throw new Error('tören anahtarının yerine dev phase-2 kurulmaz; artifacts/ceremony/ var');
  const { file: ptauFile } = await ensurePtau();
  compile();
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const initial = path.join(BUILD, 'payment_release_0000.zkey');
  await snarkjs.zKey.newZKey(FILES.r1cs, ptauFile, initial);
  // Entropi yalnızca bu süreçte yaşar; diske, loga ya da manifest'e yazılmaz.
  await snarkjs.zKey.contribute(initial, FILES.zkey, CONTRIBUTION_NAME, crypto.randomBytes(64).toString('hex'));
  fs.rmSync(initial);
  await write({ withVector: true });
}

async function check() {
  const problems = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected) problems.push(`${label}: ${actual} (beklenen ${expected})`);
  };
  const recorded = JSON.parse(fs.readFileSync(FILES.manifest, 'utf8'));
  const { file: ptauFile } = await ensurePtau();
  const circom = circomVersion();
  expect('circom', circom, recorded.circom);
  compile();
  expect('r1cs sha256', sha256(FILES.r1cs), recorded.r1cs.sha256);
  expect('wasm sha256', sha256(FILES.wasm), recorded.wasm.sha256);
  expect('zkey sha256', sha256(FILES.zkey), recorded.zkey.sha256);
  const { circuitHash, contributions } = await verifyZkey(ptauFile);
  expect('devre hash', circuitHash, recorded.circuitHash);
  const phase2 = phase2Record(contributions, readCeremony());
  expect('phase-2 kaydı', JSON.stringify(phase2), JSON.stringify(recorded.phase2));
  const { outputs } = await renderOutputs(ptauFile, { withVector: false, phase2 });
  for (const [file, text] of Object.entries(outputs)) {
    if (fs.readFileSync(file, 'utf8') !== text) problems.push(`${rel(file)}: zkey'den yeniden üretilen hâliyle aynı değil`);
  }
  if (problems.length > 0) throw new Error(`release artefaktları tutarsız:\n  ${problems.join('\n  ')}`);
  process.stdout.write(
    `ok: ${rel(FILES.zkey)} (sha256 ${recorded.zkey.sha256}) ${PTAU.file} ve devreden türüyor; ` +
      `doğrulama anahtarı ve ${rel(FILES.rustVk)} yeniden üretildi ve aynı\n`,
  );
}

/**
 * Pipeline .nvmrc'deki Node ana sürümüyle çalışır: snarkjs 0.7.6'nın zkey doğrulaması (sameRatioH)
 * ptau dosyasını açıp kapatmıyor; Node 24 bunu uyarıyla geçer, Node 26 GC sırasında hata fırlatır.
 */
function requirePinnedNode() {
  const pinned = fs.readFileSync(path.join(REPO, '.nvmrc'), 'utf8').trim();
  const major = process.versions.node.split('.')[0];
  if (major !== pinned) throw new Error(`Node ${pinned} gerekli (.nvmrc), çalışan ${process.versions.node}`);
}

const COMMANDS = { check, setup, write: () => write({ withVector: process.argv.includes('--vector') }) };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'check';
  const run = COMMANDS[command];
  try {
    if (!run) throw new Error(`bilinmeyen komut: ${command} (check | setup | write [--vector])`);
    requirePinnedNode();
    await run();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  }
}
