// BC-30: bir ağın deploy yapılandırması (`scripts/deploy/networks/<ağ>.json`) ve program kimlikleri
// (`Anchor.toml` `[programs.<ağ>]`). Yapılandırma yalnızca açık değerler taşır: Squads multisig'i, config
// talimatlarının argümanları. Anahtar taşımaz. Kurallar programların kurallarıdır (program arayüzü §10, escrow
// `config_rules.rs`): yanlış bir değer zincire gitmeden burada reddedilir.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const U64_MAX = 2n ** 64n - 1n;
const I64_MAX = 2n ** 63n - 1n;
export const PROGRAM_NAMES = Object.freeze(['registry', 'policy', 'verifier', 'escrow']);
/** escrow `state.rs`: `MAX_ARBITRATORS`, `MAX_KEEPER_FEE_BPS`; BPS paydası. */
const MAX_ARBITRATORS = 7;
const MAX_KEEPER_FEE_BPS = 100;
const BPS = 10_000;

const fail = (path, message) => {
  throw new Error(`${path}: ${message}`);
};
const address = (value, path) => (BASE58.test(value ?? '') ? value : fail(path, 'base58 adres bekleniyor'));
/** Ondalık dizi olarak taşınan tamsayı (u64 / i64); `min` ve `max` dahil. */
const integer = (value, path, min, max) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail(path, 'ondalık tamsayı dizisi bekleniyor');
  const parsed = BigInt(value);
  if (parsed < min || parsed > max) fail(path, `${min} … ${max} aralığında olmalı`);
  return parsed;
};
const small = (value, path, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fail(path, `${min} … ${max} arası tamsayı`);

/** `Anchor.toml`'un `[programs.<ağ>]` bölümü. */
export function anchorPrograms(toml, cluster) {
  const programs = {};
  let inSection = false;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inSection = line === `[programs.${cluster}]`;
    const match = inSection && /^square_([a-z]+)\s*=\s*"([^"]+)"/.exec(line);
    if (match) programs[match[1]] = address(match[2], `Anchor.toml [programs.${cluster}].square_${match[1]}`);
  }
  for (const name of PROGRAM_NAMES) {
    if (!programs[name]) fail('Anchor.toml', `[programs.${cluster}] square_${name} yok`);
  }
  return programs;
}

/** Yapılandırmayı doğrular; u64 / i64 değerleri `bigint` olarak döner. */
export function validateNetwork(config) {
  const cluster = config?.cluster;
  if (typeof cluster !== 'string' || !/^[a-z-]+$/.test(cluster)) fail('cluster', 'ağ adı bekleniyor');
  if (!/^https:\/\//.test(config.rpc ?? '')) fail('rpc', 'https adresi bekleniyor');
  const escrow = config.escrow ?? {};
  const params = escrow.params ?? {};
  const arbitrators = Array.isArray(escrow.arbitrators) ? escrow.arbitrators : fail('escrow.arbitrators', 'dizi');
  arbitrators.forEach((value, index) => address(value, `escrow.arbitrators[${index}]`));
  if (new Set(arbitrators).size !== arbitrators.length) fail('escrow.arbitrators', 'aynı adres iki kez');
  if (arbitrators.length > MAX_ARBITRATORS) fail('escrow.arbitrators', `en fazla ${MAX_ARBITRATORS}`);
  const threshold = small(escrow.threshold, 'escrow.threshold', 2, arbitrators.length);
  const minChallengePeriod = integer(params.minChallengePeriod, 'escrow.params.minChallengePeriod', 1n, I64_MAX);
  const maxChallengePeriod = integer(params.maxChallengePeriod, 'escrow.params.maxChallengePeriod', 1n, I64_MAX);
  if (minChallengePeriod > maxChallengePeriod) fail('escrow.params', 'minChallengePeriod > maxChallengePeriod');
  return {
    cluster,
    rpc: config.rpc,
    squads: { multisig: address(config.squads?.multisig, 'squads.multisig') },
    registry: {
      screenerAuthority: address(config.registry?.screenerAuthority, 'registry.screenerAuthority'),
      screeningTtlSecs: small(
        config.registry?.screeningTtlSecs,
        'registry.screeningTtlSecs',
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    },
    verifier: { mppAuthority: address(config.verifier?.mppAuthority, 'verifier.mppAuthority') },
    escrow: {
      settlementMint: address(escrow.settlementMint, 'escrow.settlementMint'),
      arbitrators,
      threshold,
      params: {
        minChallengePeriod,
        maxChallengePeriod,
        minBondBps: small(params.minBondBps, 'escrow.params.minBondBps', 0, BPS),
        minBondAbsolute: integer(params.minBondAbsolute, 'escrow.params.minBondAbsolute', 0n, U64_MAX),
        keeperFeeBps: small(params.keeperFeeBps, 'escrow.params.keeperFeeBps', 0, MAX_KEEPER_FEE_BPS),
        proofTimeoutSecs: integer(params.proofTimeoutSecs, 'escrow.params.proofTimeoutSecs', 0n, I64_MAX),
        disputeTimeoutSecs: integer(params.disputeTimeoutSecs, 'escrow.params.disputeTimeoutSecs', 1n, I64_MAX),
        travelRuleThreshold: integer(params.travelRuleThreshold, 'escrow.params.travelRuleThreshold', 0n, U64_MAX),
      },
    },
  };
}

/** Ağın yapılandırması ve program kimlikleri. */
export function loadNetwork(root, cluster) {
  const config = validateNetwork(
    JSON.parse(readFileSync(join(root, 'scripts/deploy/networks', `${cluster}.json`), 'utf8')),
  );
  if (config.cluster !== cluster) fail('cluster', `dosya adıyla (${cluster}) aynı olmalı`);
  return { ...config, programs: anchorPrograms(readFileSync(join(root, 'Anchor.toml'), 'utf8'), cluster) };
}
