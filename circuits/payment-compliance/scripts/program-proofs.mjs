#!/usr/bin/env node
// square_verifier program testlerinin (BC-21) gerçek release ispatları. Senaryolar devrenin test dünyasında
// (release-input.mjs: etiketten türetilen anahtarlar, BC-44 IDL'lerindeki program kimlikleri) kurulur;
// tests/programs aynı etiketlerden aynı anahtarları türetip job'ları, kurumu ve politikayı LiteSVM'de
// programların kendi instruction'larıyla açar. İspatlar commit'lenmiş release anahtarıyla
// (artifacts/payment.zkey, programdaki SQUARE_RELEASE_VK) üretilir.
//
//   node scripts/program-proofs.mjs          fikstürü yazar (önce `npm run build`)
//   node scripts/program-proofs.mjs --check  fikstürdeki her ispatı doğrulama anahtarıyla ve yeniden
//                                            hesaplanan sinyallerle doğrular; uymazsa 1 ile çıkar
//
// Groth16 ispatı rastgeledir; --check baytları değil, ispatın bu sinyaller için geçerliliğini denetler.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { encodeProof, fieldBytes } from './groth16-solana.mjs';
import {
  TIMESTAMP,
  buildInput,
  evaluate,
  findPda,
  keyFromLabel,
  policyCommitment,
  sha256,
  testSalts,
  toArray,
  world,
} from './release-input.mjs';
import bs58 from 'bs58';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');
const WASM = path.join(ROOT, 'build', 'payment_js', 'payment.wasm');
const ZKEY = path.join(ROOT, 'artifacts', 'payment.zkey');
const VK = path.join(ROOT, 'artifacts', 'verification_key.json');
const OUT = path.join(REPO, 'tests', 'programs', 'tests', 'fixtures', 'release-proofs.json');

const USDC = 1_000_000n;
// tests/programs aynı etiketleri `sha256("square-solana/bc-19/" ‖ etiket)` tohumuyla anahtara çevirir.
const LABELS = Object.freeze({
  institutionWallet: 'institution wallet',
  agentWallet: 'agent wallet',
  claimBuyer: 'claim buyer',
  settlementMint: 'settlement mint',
  otherMint: 'other mint',
});
const SPECS = Object.freeze({
  a: 'job spec: market research report',
  b: 'job spec: data cleaning',
  c: 'job spec: field survey',
});
const POLICY_ID = 'policy: research procurement';

// Escrow tarafı: iş tutarları ve keeper ücreti. İspattaki net, escrow'un release'te ödeyeceği
// `amount − amount × keeper_fee_bps / 10 000`'dir (program arayüzü §6).
const KEEPER_FEE_BPS = 50n;
const AMOUNTS = Object.freeze({ a: 25n * USDC, b: 40n * USDC, c: 150n * USDC });
const net = (spec) => AMOUNTS[spec] - (AMOUNTS[spec] * KEEPER_FEE_BPS) / 10_000n;
const HOUR = 3600;

function scenarios() {
  const w = world();
  const keys = Object.fromEntries(Object.entries(LABELS).map(([k, label]) => [k, keyFromLabel(label)]));
  const job = (spec) => findPda(w.escrow, ['job', bs58.decode(w.institutionWallet), sha256(SPECS[spec])]).address;
  // Politika: settlement mint'i izinli; diğerleri release-input.mjs'teki varsayılan politika.
  const base = { mint: keys.settlementMint, tokenWhitelist: [keys.settlementMint], dailySpentBefore: 0n };
  return {
    keys,
    list: [
      ['compliant', 'a', {}],
      // Kalıcı ret: işlem başı tavan (100 USDC) aşılıyor.
      ['refused_per_tx', 'c', {}],
      // Geçici ya da kurumun beyanına bağlı retler: zaman penceresi (9–17 UTC) dışı, izinsiz kategori.
      ['refused_time_window', 'a', { timestamp: TIMESTAMP + 4 * HOUR }],
      ['refused_category', 'a', { paymentCategory: 'travel' }],
      ['buyer_payee', 'a', { payee: keys.claimBuyer }],
      ['other_mint', 'a', { mint: keys.otherMint }],
      ['other_policy', 'a', { salts: 'other policy' }],
      ['job_b', 'b', {}],
      // B'nin release'inden sonra A: sayaç B'nin neti kadar ilerledi.
      ['after_job_b', 'a', { dailySpentBefore: net('b') }],
    ].map(([name, spec, overrides]) => ({
      name,
      spec,
      overrides: { ...base, netAmount: net(spec), ...overrides, job: job(spec) },
    })),
  };
}

async function input(overrides) {
  const salts = typeof overrides.salts === 'string' ? await testSalts(overrides.salts) : null;
  return buildInput({ ...overrides, salts });
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');

async function scenarioRecord({ name, spec, overrides }, proof, publicSignals) {
  const signals = await evaluate(await input(overrides));
  const encoded = encodeProof(proof, publicSignals);
  return {
    name,
    job: spec,
    payee: overrides.payee === keyFromLabel(LABELS.claimBuyer) ? 'claimBuyer' : 'agentWallet',
    mint: overrides.mint === keyFromLabel(LABELS.otherMint) ? 'otherMint' : 'settlementMint',
    net_amount: signals.net_amount,
    refusal_code: Number(signals.refusal_code),
    daily_spent_before: signals.daily_spent_before,
    timestamp: Number(signals.current_unix_timestamp),
    policy_commitment: hex(fieldBytes(signals.policy_commitment)),
    proof_a: hex(encoded.proofA),
    proof_b: hex(encoded.proofB),
    proof_c: hex(encoded.proofC),
  };
}

async function policyRecord() {
  const defaults = await input({ ...scenarios().list[0].overrides });
  return {
    policy_id: POLICY_ID,
    commitment: hex(fieldBytes(String(await policyCommitment(defaults)))),
    daily_ceiling: defaults.daily_ceiling_in,
  };
}

async function write() {
  const vk = JSON.parse(fs.readFileSync(VK, 'utf8'));
  const { list } = scenarios();
  const records = [];
  for (const scenario of list) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(await input(scenario.overrides), WASM, ZKEY);
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${scenario.name}: ispat doğrulanmadı`);
    records.push(await scenarioRecord(scenario, proof, publicSignals));
    process.stdout.write(`${scenario.name}: refusal_code ${records.at(-1).refusal_code}\n`);
  }
  const fixture = {
    generator: 'circuits/payment-compliance/scripts/program-proofs.mjs',
    key: 'circuits/payment-compliance/artifacts/payment.zkey (development phase-2, BC-20)',
    seed_prefix: 'square-solana/bc-19/',
    labels: LABELS,
    specs: SPECS,
    amounts: Object.fromEntries(Object.entries(AMOUNTS).map(([k, v]) => [k, String(v)])),
    keeper_fee_bps: Number(KEEPER_FEE_BPS),
    timestamp: TIMESTAMP,
    policy: await policyRecord(),
    scenarios: records,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(REPO, OUT)}\n`);
}

const fromHex = (text) => Array.from(Buffer.from(text, 'hex'));

/** groth16-solana kodlaması → snarkjs ispatı (proof_a'nın y'si negatifti). */
function decodeProof({ proof_a, proof_b, proof_c }) {
  const field = (bytes) => BigInt(`0x${Buffer.from(bytes).toString('hex')}`).toString();
  const p = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
  const a = fromHex(proof_a);
  const b = fromHex(proof_b);
  const c = fromHex(proof_c);
  const negY = BigInt(field(a.slice(32)));
  return {
    pi_a: [field(a.slice(0, 32)), ((p - negY) % p).toString(), '1'],
    pi_b: [
      [field(b.slice(32, 64)), field(b.slice(0, 32))],
      [field(b.slice(96, 128)), field(b.slice(64, 96))],
      ['1', '0'],
    ],
    pi_c: [field(c.slice(0, 32)), field(c.slice(32)), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}

async function check() {
  const vk = JSON.parse(fs.readFileSync(VK, 'utf8'));
  const fixture = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const { list } = scenarios();
  const problems = [];
  if (JSON.stringify(fixture.labels) !== JSON.stringify(LABELS)) problems.push('etiketler değişmiş');
  if (JSON.stringify(fixture.specs) !== JSON.stringify(SPECS)) problems.push('işler değişmiş');
  if (fixture.keeper_fee_bps !== Number(KEEPER_FEE_BPS)) problems.push('keeper ücreti değişmiş');
  for (const [spec, amount] of Object.entries(AMOUNTS)) {
    if (fixture.amounts?.[spec] !== String(amount)) problems.push(`${spec} işinin tutarı değişmiş`);
  }
  if (JSON.stringify(fixture.policy) !== JSON.stringify(await policyRecord())) problems.push('politika değişmiş');
  if (fixture.scenarios.length !== list.length) problems.push('senaryo sayısı farklı');
  for (const scenario of list) {
    const record = fixture.scenarios.find((s) => s.name === scenario.name);
    if (!record) {
      problems.push(`${scenario.name}: fikstürde yok`);
      continue;
    }
    const signals = toArray(await evaluate(await input(scenario.overrides)));
    if (!(await snarkjs.groth16.verify(vk, signals, decodeProof(record)))) {
      problems.push(`${scenario.name}: ispat bu sinyaller ve doğrulama anahtarıyla doğrulanmıyor`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${path.relative(REPO, OUT)} güncel değil (node scripts/program-proofs.mjs):\n  ${problems.join('\n  ')}`);
  }
  process.stdout.write(`${path.relative(REPO, OUT)}: ${list.length} ispat geçerli\n`);
}

try {
  await (process.argv.includes('--check') ? check() : write());
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
}
