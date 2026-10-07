#!/usr/bin/env node
// square_verifier program testlerinin (BC-21) gerçek release ispatları. Senaryolar devrenin test dünyasında
// (release-input.mjs: etiketten türetilen anahtarlar, BC-44 IDL'lerindeki program kimlikleri) kurulur;
// tests/programs aynı etiketlerden aynı anahtarları türetip job'ları, kurumu ve politikayı LiteSVM'de
// programların kendi instruction'larıyla açar. İspatlar commit'lenmiş release anahtarıyla
// (artifacts/payment.zkey, programdaki SQUARE_RELEASE_VK) üretilir.
//
//   node scripts/program-proofs.mjs           iki fikstürü yazar (önce `npm run build`)
//   node scripts/program-proofs.mjs --squads  yalnızca Squads fikstürünü yazar (BC-35)
//   node scripts/program-proofs.mjs --missing yalnızca fikstürde olmayan senaryoları üretip ekler; mevcut
//                                             ispatlar (ve Squads fikstürü) olduğu gibi kalır
//   node scripts/program-proofs.mjs --check   fikstürlerdeki her ispatı doğrulama anahtarıyla ve yeniden
//                                             hesaplanan sinyallerle doğrular; uymazsa 1 ile çıkar
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
  getPoseidon,
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
  // Politikanın engelli adresi (release-input.mjs `blockedWallet`): alacağı alırsa release kesin ret olur.
  blockedWallet: 'sanctioned wallet',
});
const SPECS = Object.freeze({
  a: 'job spec: market research report',
  b: 'job spec: data cleaning',
  c: 'job spec: field survey',
  // Fiat rayı (BC-37): Stripe ile ödenen iş.
  d: 'job spec: fiat market research',
});
const POLICY_ID = 'policy: research procurement';

// Escrow tarafı: iş tutarları ve keeper ücreti. İspattaki net, escrow'un release'te ödeyeceği
// `amount − amount × keeper_fee_bps / 10 000`'dir (program arayüzü §6).
const KEEPER_FEE_BPS = 50n;
const AMOUNTS = Object.freeze({ a: 25n * USDC, b: 40n * USDC, c: 150n * USDC, d: 30n * USDC });
const net = (spec) => AMOUNTS[spec] - (AMOUNTS[spec] * KEEPER_FEE_BPS) / 10_000n;
const HOUR = 3600;
// Kabul öncesi ön-ispat (ADR 0028): test dünyalarında iş, ispatların anından iki saat önce kabul edilir.
const PREFLIGHT_TIMESTAMP = TIMESTAMP - 2 * HOUR;
/** İşin kendi koşulları: net tutarın tamamı, payee agent cüzdanı, sayaç 0 (verifier `set_preflight_proof`). */
const preflight = (spec) => ({ netAmount: AMOUNTS[spec], dailySpentBefore: 0n, timestamp: PREFLIGHT_TIMESTAMP });

// MPP yolu (BC-37): makbuz commitment'ı bir BN254 alan elemanıdır. Fikstürünki etiketten türetilir
// (`Poseidon(sha256(etiket)'in iki 128 bitlik yarısı)`); program yalnızca ispattaki ve attestation'daki
// değerin aynı ve sıfırdan farklı olmasına bakar.
const STRIPE_RECEIPT_LABEL = 'square-solana/bc-37/stripe receipt';
async function stripeReceiptHash() {
  const poseidon = await getPoseidon();
  const digest = sha256(STRIPE_RECEIPT_LABEL);
  const halves = [digest.subarray(0, 16), digest.subarray(16)].map((half) => BigInt(`0x${half.toString('hex')}`));
  return BigInt(poseidon.F.toString(poseidon(halves)));
}
const STRIPE_RECEIPT_HASH = await stripeReceiptHash();

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
      // Kalıcı ret (ADR 0028'den sonra tek yolu): alacak politikanın engelli adresine satıldı, payee o.
      ['refused_blocked_buyer', 'a', { payee: keys.blockedWallet }],
      // Geçici ya da kurumun beyanına bağlı retler: zaman penceresi (9–17 UTC) dışı, izinsiz kategori.
      ['refused_time_window', 'a', { timestamp: TIMESTAMP + 4 * HOUR }],
      ['refused_category', 'a', { paymentCategory: 'travel' }],
      ['buyer_payee', 'a', { payee: keys.claimBuyer }],
      ['other_mint', 'a', { mint: keys.otherMint }],
      ['other_policy', 'a', { salts: 'other policy' }],
      ['job_b', 'b', {}],
      // B'nin release'inden sonra A: sayaç B'nin neti kadar ilerledi.
      ['after_job_b', 'a', { dailySpentBefore: net('b') }],
      // Dispute kararları (BC-32): agent tarafına keeper ücreti kesilmeden tam tutar (FavorAgent) ve
      // kısmi tutar (Split, 10 USDC); escrow `execute_resolution`'da bu netleri bekler.
      ['dispute_favor_agent', 'a', { netAmount: AMOUNTS.a }],
      ['dispute_split', 'a', { netAmount: 10n * USDC }],
      // FavorAgent kararında payee engelli alıcı: kalıcı ret, iade.
      ['dispute_refused_blocked_buyer', 'a', { netAmount: AMOUNTS.a, payee: keys.blockedWallet }],
      // Fiat rayı (BC-37): Stripe ödemesi işin tamamıdır (keeper ücreti yok), makbuz commitment'ı sinyal 12.
      ['mpp_fiat', 'd', { netAmount: AMOUNTS.d, stripeReceiptHash: STRIPE_RECEIPT_HASH }],
      // Kabul öncesi ön-ispatlar (ADR 0028). c işi işlem başı tavanı (100 USDC) aşar: kalıcı ret, kabul edilemez.
      ['preflight_a', 'a', preflight('a')],
      ['preflight_b', 'b', preflight('b')],
      ['preflight_c', 'c', preflight('c')],
      ['preflight_d', 'd', preflight('d')],
    ].map(([name, spec, overrides]) => ({
      name,
      spec,
      overrides: { ...base, netAmount: net(spec), ...overrides, job: job(spec) },
    })),
  };
}

// ------------------------------------------------------------- Squads vault'ları (BC-35)

// Rol imzacıları Squads v4 vault PDA'larıdır: kurum, agent cüzdanı ve alıcı. Multisig hesaplarının
// adresleri etiketlerden türetilir; tests/programs aynı adreslere Squads'a ait bir `Multisig` hesabı yazar
// ve vault'u imzacı olarak kullanır (square_common::squads::vault_address). Tek senaryo akışın sekiz
// adımını kapsar: alacak alıcı vault'una satılır, payee odur.
const SQUADS_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
const SQUADS_OUT = path.join(REPO, 'tests', 'programs', 'tests', 'fixtures', 'squads-proofs.json');
const SQUADS_LABELS = Object.freeze({
  institutionMultisig: 'institution multisig',
  agentMultisig: 'agent multisig',
  buyerMultisig: 'buyer multisig',
  settlementMint: LABELS.settlementMint,
});
const SQUADS_SPEC = 'job spec: squads market research';
const SQUADS_AMOUNT = AMOUNTS.a;
const VAULT_INDEX = 0;

const vaultOf = (multisig) =>
  findPda(SQUADS_PROGRAM_ID, ['multisig', bs58.decode(multisig), 'vault', [VAULT_INDEX]]).address;

function squadsWorld() {
  const w = world();
  const multisig = (key) => keyFromLabel(SQUADS_LABELS[key]);
  const vaults = {
    institution: vaultOf(multisig('institutionMultisig')),
    agent: vaultOf(multisig('agentMultisig')),
    buyer: vaultOf(multisig('buyerMultisig')),
  };
  const institution = findPda(w.policy, ['institution', bs58.decode(vaults.institution)]).address;
  const job = findPda(w.escrow, ['job', bs58.decode(vaults.institution), sha256(SQUADS_SPEC)]).address;
  const mint = keyFromLabel(SQUADS_LABELS.settlementMint);
  const netAmount = SQUADS_AMOUNT - (SQUADS_AMOUNT * KEEPER_FEE_BPS) / 10_000n;
  const base = { institution, job, mint, tokenWhitelist: [mint], dailySpentBefore: 0n };
  return {
    vaults,
    overrides: { ...base, payee: vaults.buyer, netAmount },
    // Kabul öncesi ön-ispat (ADR 0028): payee agent vault'u, net tutarın tamamı, sayaç 0.
    preflight: { ...base, payee: vaults.agent, netAmount: SQUADS_AMOUNT, timestamp: PREFLIGHT_TIMESTAMP },
  };
}

/** Squads fikstürünün senaryoları: adı, ispat girdisi ve payee'nin etiketi. */
const squadsScenarios = () => {
  const w = squadsWorld();
  return [
    { name: 'buyer_vault_payee', overrides: w.overrides, payee: 'buyerVault' },
    { name: 'preflight', overrides: w.preflight, payee: 'agentVault' },
  ];
};

async function squadsFixture(records) {
  const { overrides } = squadsWorld();
  const defaults = await input(overrides);
  return {
    generator: 'circuits/payment-compliance/scripts/program-proofs.mjs --squads',
    key: 'circuits/payment-compliance/artifacts/payment.zkey (development phase-2, BC-20)',
    seed_prefix: 'square-solana/bc-19/',
    squads_program: SQUADS_PROGRAM_ID,
    vault_index: VAULT_INDEX,
    labels: SQUADS_LABELS,
    spec: SQUADS_SPEC,
    amount: String(SQUADS_AMOUNT),
    keeper_fee_bps: Number(KEEPER_FEE_BPS),
    timestamp: TIMESTAMP,
    policy: {
      policy_id: POLICY_ID,
      commitment: hex(fieldBytes(String(await policyCommitment(defaults)))),
      daily_ceiling: defaults.daily_ceiling_in,
    },
    scenarios: records,
  };
}

async function squadsRecord({ name, overrides, payee }, proof, publicSignals) {
  const signals = await evaluate(await input(overrides));
  const encoded = encodeProof(proof, publicSignals);
  return {
    name,
    job: 'squads',
    payee,
    mint: 'settlementMint',
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

async function writeSquads(vk, { missingOnly = false } = {}) {
  const existing = missingOnly && fs.existsSync(SQUADS_OUT) ? JSON.parse(fs.readFileSync(SQUADS_OUT, 'utf8')).scenarios : [];
  const records = [];
  for (const scenario of squadsScenarios()) {
    const kept = existing.find((s) => s.name === scenario.name);
    if (kept) {
      records.push(kept);
      continue;
    }
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(await input(scenario.overrides), WASM, ZKEY);
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`squads ${scenario.name}: ispat doğrulanmadı`);
    records.push(await squadsRecord(scenario, proof, publicSignals));
    process.stdout.write(`squads ${scenario.name}: refusal_code ${records.at(-1).refusal_code}\n`);
  }
  fs.writeFileSync(SQUADS_OUT, `${JSON.stringify(await squadsFixture(records), null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(REPO, SQUADS_OUT)}\n`);
}

async function checkSquads(vk, problems) {
  if (!fs.existsSync(SQUADS_OUT)) {
    problems.push(`${path.relative(REPO, SQUADS_OUT)} yok`);
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(SQUADS_OUT, 'utf8'));
  // Senaryo dışındaki her alan (etiketler, iş, tutar, politika) betiğin bugünkü dünyasıyla aynı olmalı.
  const expected = await squadsFixture([]);
  const { scenarios, ...actual } = fixture;
  delete expected.scenarios;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push('squads: fikstürün dünyası değişmiş');
  const list = squadsScenarios();
  if (scenarios.length !== list.length) problems.push('squads: senaryo sayısı farklı');
  for (const scenario of list) {
    const record = scenarios.find((s) => s.name === scenario.name);
    if (!record) {
      problems.push(`squads ${scenario.name}: fikstürde yok`);
      continue;
    }
    const signals = toArray(await evaluate(await input(scenario.overrides)));
    if (!(await snarkjs.groth16.verify(vk, signals, decodeProof(record)))) {
      problems.push(`squads ${scenario.name}: ispat bu sinyaller ve doğrulama anahtarıyla doğrulanmıyor`);
    }
  }
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
    payee:
      overrides.payee === keyFromLabel(LABELS.claimBuyer)
        ? 'claimBuyer'
        : overrides.payee === keyFromLabel(LABELS.blockedWallet)
          ? 'blockedWallet'
          : 'agentWallet',
    mint: overrides.mint === keyFromLabel(LABELS.otherMint) ? 'otherMint' : 'settlementMint',
    net_amount: signals.net_amount,
    refusal_code: Number(signals.refusal_code),
    daily_spent_before: signals.daily_spent_before,
    timestamp: Number(signals.current_unix_timestamp),
    policy_commitment: hex(fieldBytes(signals.policy_commitment)),
    ...(BigInt(signals.stripe_receipt_hash) === 0n
      ? {}
      : { stripe_receipt_hash: hex(fieldBytes(signals.stripe_receipt_hash)) }),
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

async function write({ missingOnly = false } = {}) {
  const vk = JSON.parse(fs.readFileSync(VK, 'utf8'));
  const { list } = scenarios();
  const existing = missingOnly ? JSON.parse(fs.readFileSync(OUT, 'utf8')).scenarios : [];
  const records = [];
  for (const scenario of list) {
    const kept = existing.find((s) => s.name === scenario.name);
    if (kept) {
      records.push(kept);
      continue;
    }
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
  await writeSquads(vk, { missingOnly });
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
  await checkSquads(vk, problems);
  if (problems.length > 0) {
    throw new Error(`fikstürler güncel değil (node scripts/program-proofs.mjs):\n  ${problems.join('\n  ')}`);
  }
  process.stdout.write(`${path.relative(REPO, OUT)}: ${list.length} ispat geçerli\n`);
  process.stdout.write(`${path.relative(REPO, SQUADS_OUT)}: ${squadsScenarios().length} ispat geçerli\n`);
}

try {
  if (process.argv.includes('--check')) await check();
  else if (process.argv.includes('--squads')) await writeSquads(JSON.parse(fs.readFileSync(VK, 'utf8')));
  else await write({ missingOnly: process.argv.includes('--missing') });
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
}
