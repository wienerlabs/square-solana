import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { anchorPrograms, loadNetwork, validateNetwork } from './network-config.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const A = 'DPF8Myr3engeVLgCvxhTmLZQANYb7rKA8aSvZpz9cM3q';
const B = 'EZggdp7BCPLU84UBz2WFw4yvEC6KM3ZH6mjPANYQRPmQ';
const C = '4DepaL4Dqp6NKzz5oHFjMY3b6FCDvFrqABd62YsUohtE';

const base = () => ({
  cluster: 'devnet',
  rpc: 'https://api.devnet.solana.com',
  squads: { multisig: A },
  registry: { screenerAuthority: B, screeningTtlSecs: 86_400 },
  verifier: { mppAuthority: C },
  escrow: {
    settlementMint: A,
    arbitrators: [A, B, C],
    threshold: 2,
    params: {
      minChallengePeriod: '60',
      maxChallengePeriod: '604800',
      minBondBps: 1000,
      minBondAbsolute: '1000000',
      keeperFeeBps: 50,
      proofTimeoutSecs: '0',
      disputeTimeoutSecs: '604800',
      travelRuleThreshold: '0',
    },
  },
});
const withEscrow = (change) => {
  const config = base();
  config.escrow = { ...config.escrow, ...change, params: { ...config.escrow.params, ...change.params } };
  return config;
};

test('geçerli yapılandırma; u64 / i64 bigint olur', () => {
  const config = validateNetwork(base());
  assert.equal(config.escrow.params.maxChallengePeriod, 604_800n);
  assert.equal(config.escrow.params.keeperFeeBps, 50);
  assert.equal(config.registry.screeningTtlSecs, 86_400);
});

test('programların kuralları: eşik, arbitrator seti, keeper ücreti, süreler', () => {
  assert.throws(() => validateNetwork(withEscrow({ threshold: 1 })), /threshold/);
  assert.throws(() => validateNetwork(withEscrow({ threshold: 4 })), /threshold/);
  assert.throws(() => validateNetwork(withEscrow({ arbitrators: [A, A, B] })), /iki kez/);
  assert.throws(() => validateNetwork(withEscrow({ arbitrators: [A, 'x', B] })), /arbitrators\[1\]/);
  assert.throws(() => validateNetwork(withEscrow({ params: { keeperFeeBps: 101 } })), /keeperFeeBps/);
  assert.throws(() => validateNetwork(withEscrow({ params: { disputeTimeoutSecs: '0' } })), /disputeTimeoutSecs/);
  assert.throws(() => validateNetwork(withEscrow({ params: { minChallengePeriod: '900000' } })), /min.*max/);
  assert.throws(() => validateNetwork(withEscrow({ params: { minBondAbsolute: 5 } })), /ondalık/);
  assert.throws(
    () => validateNetwork(withEscrow({ params: { travelRuleThreshold: '18446744073709551616' } })),
    /aralığında/,
  );
  assert.throws(() => validateNetwork({ ...base(), rpc: 'http://x' }), /rpc/);
});

test('Anchor.toml bölümü: dört program zorunlu', () => {
  const toml = `[programs.localnet]\nsquare_policy = "${A}"\n\n[programs.devnet]\nsquare_policy = "${A}"\nsquare_verifier = "${B}"\nsquare_registry = "${C}"\nsquare_escrow = "${A}"\n`;
  assert.deepEqual(anchorPrograms(toml, 'devnet'), { policy: A, verifier: B, registry: C, escrow: A });
  assert.throws(() => anchorPrograms(toml, 'localnet'), /square_registry yok/);
});

test('depodaki devnet yapılandırması geçerli ve Anchor.toml ile birlikte okunur', () => {
  const network = loadNetwork(REPO, 'devnet');
  assert.equal(network.cluster, 'devnet');
  assert.deepEqual(Object.keys(network.programs).sort(), ['escrow', 'policy', 'registry', 'verifier']);
});
