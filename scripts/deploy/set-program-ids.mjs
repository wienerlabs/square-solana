// BC-09: Square program kimliklerini depoya uygular ([runbook](../../docs/runbooks/upgrade.md)). Kimlikler
// yeni program keypair'lerinin açık anahtarlarıdır; keypair'ler secret store'dadır ve bu betik onları
// okumaz. Değişen yerler:
// - `programs/<crate>/src/lib.rs`: `declare_id!`;
// - `Anchor.toml`: `[programs.localnet]` ve `[programs.devnet]` (yoksa eklenir);
// - `idl/<program>_contract.json`: `address` ve programın kendi adresini taşıyan hesaplar
//   (`init_*` talimatlarının `program` hesabı).
// Sonrasında türetilen dosyalar ve ispat fikstürleri yeniden üretilir (runbook adım 2). Betik, eski
// kimliklerin depoda kalan geçişlerini (kaynak projelerin tarihsel kayıtları hariç) listeler.
//
//   node scripts/deploy/set-program-ids.mjs --policy <id> --verifier <id> --registry <id> --escrow <id> [--root .]
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Anchor.toml anahtarı → crate dizini ve sözleşme IDL'i. */
export const PROGRAMS = Object.freeze({
  square_policy: { crate: 'square-policy', flag: 'policy' },
  square_verifier: { crate: 'square-verifier', flag: 'verifier' },
  square_registry: { crate: 'square-registry', flag: 'registry' },
  square_escrow: { crate: 'square-escrow', flag: 'escrow' },
});

/**
 * Eski kimliklerin kalması beklenen dosyalar: kaynak projelerin kayıtları ve AIP v1'in (kaynak registry'nin)
 * did:aip v1 çözümü. Bunlar Square'in program kimliği değil, kaynağın tarihsel adresidir.
 */
export const HISTORICAL = Object.freeze([
  'docs/analysis/',
  'docs/did-aip/',
  'docs/provenance/',
  'packages/identity/src/constants.ts',
  'packages/identity/test/fixtures/',
  'tests/legacy/',
]);

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseArgs(argv) {
  const args = { root: fileURLToPath(new URL('../../', import.meta.url)), ids: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else {
      const name = Object.keys(PROGRAMS).find((n) => `--${PROGRAMS[n].flag}` === arg);
      if (!name) throw new Error(`bilinmeyen argüman: ${arg}`);
      const id = argv[++i];
      if (!BASE58.test(id ?? '')) throw new Error(`${arg}: base58 program kimliği değil: ${id}`);
      args.ids[name] = id;
    }
  }
  const missing = Object.keys(PROGRAMS).filter((n) => !args.ids[n]);
  if (missing.length > 0) throw new Error(`eksik kimlik: ${missing.map((n) => `--${PROGRAMS[n].flag}`).join(', ')}`);
  const values = Object.values(args.ids);
  if (new Set(values).size !== values.length) throw new Error('aynı kimlik iki programa verilmiş');
  return args;
}

/** `declare_id!("...")`'ı değiştirir; döndürdüğü eski kimliktir. */
export function replaceDeclareId(source, id) {
  const match = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);/.exec(source);
  if (!match) throw new Error('declare_id! bulunamadı');
  return { previous: match[1], source: source.replace(match[0], `declare_id!("${id}");`) };
}

const TOML_COMMENT = '# Square program kimlikleri (BC-09); scripts/deploy/set-program-ids.mjs yazar.';

/** `[programs.<cluster>]` bölümünü verilen kimliklerle yazar; bölüm yoksa `[programs.localnet]`'ten sonra ekler. */
export function writeAnchorToml(toml, cluster, ids) {
  const lines = Object.keys(PROGRAMS).map((name) => `${name} = "${ids[name]}"`);
  const block = [`[programs.${cluster}]`, TOML_COMMENT, ...lines].join('\n');
  // Bölüm: başlık ve bir sonraki boş satıra ya da başlığa kadarki satırlar.
  const section = (name) => new RegExp(`\\[programs\\.${name}\\]\\n(?:[^\\n\\[][^\\n]*\\n)*`);
  const existing = section(cluster).exec(toml);
  if (existing) return toml.replace(existing[0], `${block}\n`);
  const localnet = section('localnet').exec(toml);
  if (!localnet) throw new Error('Anchor.toml: [programs.localnet] yok');
  const at = localnet.index + localnet[0].length;
  return `${toml.slice(0, at)}\n${block}\n${toml.slice(at)}`;
}

/** Sözleşme IDL'inde programın kendi adresini (`address` ve aynı değerli hesap adresleri) değiştirir. */
export function replaceIdlAddress(idl, id) {
  const previous = idl.address;
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, k === 'address' && v === previous ? id : visit(v)]),
      );
    }
    return value;
  };
  return { previous, idl: visit(idl) };
}

export function apply(root, ids) {
  const previous = {};
  for (const [name, { crate }] of Object.entries(PROGRAMS)) {
    const lib = join(root, 'programs', crate, 'src', 'lib.rs');
    const result = replaceDeclareId(readFileSync(lib, 'utf8'), ids[name]);
    writeFileSync(lib, result.source);
    previous[name] = result.previous;

    const idlPath = join(root, 'idl', `${name}_contract.json`);
    const raw = readFileSync(idlPath, 'utf8');
    const replaced = replaceIdlAddress(JSON.parse(raw), ids[name]);
    if (replaced.previous !== result.previous) {
      throw new Error(`${name}: IDL adresi (${replaced.previous}) declare_id! ile (${result.previous}) farklı`);
    }
    writeFileSync(idlPath, `${JSON.stringify(replaced.idl, null, 2)}${raw.endsWith('\n') ? '\n' : ''}`);
  }
  const tomlPath = join(root, 'Anchor.toml');
  let toml = readFileSync(tomlPath, 'utf8');
  for (const cluster of ['localnet', 'devnet']) toml = writeAnchorToml(toml, cluster, ids);
  writeFileSync(tomlPath, toml);
  return previous;
}

/** Depoda `ids` değerlerinin geçtiği, tarihsel olmayan dosyalar (git'in izlediği dosyalar). */
export function leftovers(root, ids) {
  const out = [];
  for (const id of ids) {
    let files = [];
    try {
      files = execFileSync('git', ['grep', '-l', '--fixed-strings', id], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch (error) {
      if (error.status !== 1) throw error; // 1: eşleşme yok
    }
    for (const file of files) if (!HISTORICAL.some((prefix) => file.startsWith(prefix))) out.push({ id, file });
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const previous = apply(args.root, args.ids);
  process.stdout.write('[ids] declare_id!, Anchor.toml (localnet, devnet) ve sözleşme IDL adresleri güncellendi\n');
  const rest = leftovers(args.root, Object.values(previous));
  for (const { id, file } of rest) process.stdout.write(`[ids] eski kimlik ${id} hâlâ: ${file}\n`);
  process.stdout.write(
    'sonraki adımlar: pnpm --filter @squaresdk/solana-types gen && pnpm --filter @squaresdk/solana-sdk gen; ' +
      'anchor build; node scripts/ci/idl-conformance.mjs; circuits/payment-compliance: node scripts/program-proofs.mjs; ' +
      'program testleri (docs/runbooks/upgrade.md, adım 2)\n',
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
