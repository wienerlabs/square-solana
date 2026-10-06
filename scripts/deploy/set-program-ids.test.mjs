import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  apply,
  parseArgs,
  PROGRAMS,
  replaceDeclareId,
  replaceIdlAddress,
  writeAnchorToml,
} from './set-program-ids.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
// Geçerli base58, birbirinden farklı dört kimlik (anahtar değil; yalnızca biçim).
const IDS = Object.freeze({
  square_policy: 'Po1icy1111111111111111111111111111111111111',
  square_verifier: 'Ver1fier111111111111111111111111111111111111',
  square_registry: 'Reg1stry111111111111111111111111111111111111',
  square_escrow: 'Escrow1111111111111111111111111111111111111',
});
const ARGS = Object.entries(IDS).flatMap(([name, id]) => [`--${PROGRAMS[name].flag}`, id]);

test('argümanlar: dört kimlik zorunlu, biçim ve tekrar denetlenir', () => {
  assert.deepEqual(parseArgs([...ARGS, '--root', '/x']).ids, IDS);
  assert.throws(() => parseArgs(ARGS.slice(2)), /eksik kimlik: --policy/);
  assert.throws(() => parseArgs([...ARGS.slice(0, 7), 'not-base58!']), /base58/);
  const twice = [...ARGS];
  twice[3] = IDS.square_policy;
  assert.throws(() => parseArgs(twice), /aynı kimlik/);
  assert.throws(() => parseArgs(['--unknown']), /bilinmeyen/);
});

test('declare_id! değişir, eski kimlik döner', () => {
  const { previous, source } = replaceDeclareId(
    'a\ndeclare_id!("Prev111111111111111111111111111111111111111");\nb',
    'New',
  );
  assert.equal(previous, 'Prev111111111111111111111111111111111111111');
  assert.equal(source, 'a\ndeclare_id!("New");\nb');
  assert.throws(() => replaceDeclareId('x', 'y'), /bulunamadı/);
});

test("Anchor.toml: devnet bölümü localnet'ten sonra eklenir, ikinci yazım aynı sonucu verir", () => {
  const toml = readFileSync(join(REPO, 'Anchor.toml'), 'utf8');
  const once = writeAnchorToml(writeAnchorToml(toml, 'localnet', IDS), 'devnet', IDS);
  const twice = writeAnchorToml(writeAnchorToml(once, 'localnet', IDS), 'devnet', IDS);
  assert.equal(twice, once);
  assert.match(once, /\[programs\.localnet\]\n# Square program kimlikleri[^\n]*\nsquare_policy = "Po1icy1+"\n/);
  assert.match(once, /square_escrow = "Escrow1+"\n\n\[programs\.devnet\]\n/);
  assert.match(once, /\[programs\.devnet\][\s\S]*square_escrow = "Escrow1+"\n\n\[provider\]/);
  // Diğer bölümler değişmez.
  assert.equal(once.split('[toolchain]')[0], toml.split('[toolchain]')[0]);
  assert.match(once, /\[scripts\]\n#[^\n]*\ntest = /);
});

test('IDL: yalnızca programın kendi adresi değişir', () => {
  const idl = {
    address: 'Old',
    instructions: [
      {
        accounts: [
          { name: 'program', address: 'Old' },
          { name: 'system_program', address: '111' },
        ],
      },
    ],
  };
  const { previous, idl: out } = replaceIdlAddress(idl, 'New');
  assert.equal(previous, 'Old');
  assert.equal(out.address, 'New');
  assert.deepEqual(out.instructions[0].accounts, [
    { name: 'program', address: 'New' },
    { name: 'system_program', address: '111' },
  ]);
});

test("apply: geçici bir kopyada dört program, IDL'ler ve Anchor.toml", () => {
  const root = mkdtempSync(join(tmpdir(), 'program-ids-'));
  try {
    cpSync(join(REPO, 'Anchor.toml'), join(root, 'Anchor.toml'));
    mkdirSync(join(root, 'idl'));
    for (const [name, { crate }] of Object.entries(PROGRAMS)) {
      mkdirSync(join(root, 'programs', crate, 'src'), { recursive: true });
      cpSync(join(REPO, 'programs', crate, 'src', 'lib.rs'), join(root, 'programs', crate, 'src', 'lib.rs'));
      cpSync(join(REPO, 'idl', `${name}_contract.json`), join(root, 'idl', `${name}_contract.json`));
    }
    const previous = apply(root, IDS);
    for (const [name, { crate }] of Object.entries(PROGRAMS)) {
      const before = JSON.parse(readFileSync(join(REPO, 'idl', `${name}_contract.json`), 'utf8'));
      assert.equal(previous[name], before.address);
      const lib = readFileSync(join(root, 'programs', crate, 'src', 'lib.rs'), 'utf8');
      assert.match(lib, new RegExp(`declare_id!\\("${IDS[name]}"\\);`));
      const idl = readFileSync(join(root, 'idl', `${name}_contract.json`), 'utf8');
      assert.ok(!idl.includes(before.address), `${name}: eski adres IDL'de kaldı`);
      assert.equal(JSON.parse(idl).address, IDS[name]);
    }
    const toml = readFileSync(join(root, 'Anchor.toml'), 'utf8');
    assert.equal(toml.match(/square_escrow = "Escrow1+"/g).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
