import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('pack-files.mjs', import.meta.url));
const LICENSE = 'Apache License\nVersion 2.0, January 2004\n';
const NOTICE = 'Square (Solana)\nCopyright 2026 Wiener Labs\n';
const MIT = 'MIT License\n\nCopyright (c) 2026 Agent Internet Protocol\n';
const UPSTREAM_NOTICE = 'Upstream\nCopyright 2026 Upstream authors\n';

const temporaries = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(packages = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pack-files-'));
  temporaries.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(root, 'LICENSE'), LICENSE);
  writeFileSync(join(root, 'NOTICE'), NOTICE);
  mkdirSync(join(root, 'packages'));
  for (const [name, { manifest, files = {} }] of Object.entries(packages)) {
    const dir = join(root, 'packages', name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  }
  return root;
}

const library = (overrides = {}) => ({
  name: '@squaresdk/solana-sdk',
  license: 'Apache-2.0',
  private: true,
  files: ['dist', 'LICENSE', 'NOTICE'],
  ...overrides,
});

const synced = () => ({ manifest: library(), files: { LICENSE, NOTICE } });

const ungoverned = {
  'agent-sdk': {
    manifest: { name: '@squaresdk/solana-agent-sdk', license: 'MIT', private: true, files: ['dist', 'README.md'] },
    files: { LICENSE: MIT },
  },
  mcp: {
    manifest: { name: '@squaresdk/solana-mcp', license: 'Apache-2.0', private: true, files: ['dist', 'src'] },
  },
  upstream: {
    manifest: { name: '@squaresdk/solana-upstream', license: 'MIT', files: ['dist', 'LICENSE', 'NOTICE'] },
    files: { LICENSE: MIT, NOTICE: UPSTREAM_NOTICE },
  },
};

const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const read = (root, path) => readFileSync(join(root, path), 'utf8');

describe('pack-files --check', () => {
  it('kopyalar kökle bayt bayt aynıysa geçer', () => {
    const result = run(repo({ sdk: synced() }), '--check');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 paketin .*: packages\/sdk$/m);
  });

  it('Apache-2.0 olmayan ya da private olup kopya listelemeyen paket denetlenmez', () => {
    const result = run(repo({ sdk: synced(), ...ungoverned }), '--check');
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /agent-sdk|mcp|upstream/);
  });

  it('package.json olmayan dizin denetlenmez', () => {
    const root = repo({ sdk: synced() });
    mkdirSync(join(root, 'packages', 'notes'));
    writeFileSync(join(root, 'packages', 'notes', 'NOTICE'), 'eski\n');
    const result = run(root, '--check');
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /notes/);
  });

  const drifted = /packages\/sdk\/NOTICE kökteki NOTICE ile aynı değil/;
  const broken = [
    ['kökten sapan NOTICE', library(), { LICENSE, NOTICE: `${NOTICE}eski satır\n` }, drifted],
    ['yalnız satır sonları farklı NOTICE', library(), { LICENSE, NOTICE: NOTICE.replaceAll('\n', '\r\n') }, drifted],
    ['eksik LICENSE kopyası', library(), { NOTICE }, /packages\/sdk\/LICENSE yok/],
    [
      '"files" alanında LICENSE olmaması',
      library({ files: ['dist', 'NOTICE'] }),
      { LICENSE, NOTICE },
      /packages\/sdk\/package\.json: "files" LICENSE içermiyor/,
    ],
    [
      'private olmayan Apache-2.0 paketin kopyasız olması',
      library({ private: undefined, files: ['dist'] }),
      {},
      /packages\/sdk\/package\.json: "files" NOTICE içermiyor/,
    ],
  ];
  for (const [title, manifest, files, expected] of broken) {
    it(`${title} kapıyı kırar`, () => {
      const result = run(repo({ sdk: { manifest, files } }), '--check');
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
      assert.match(result.stderr, /pnpm license:write/);
    });
  }

  it('sembolik bağ olan kopya kapıyı kırar', () => {
    const root = repo({ sdk: { manifest: library(), files: { NOTICE } } });
    symlinkSync(join('..', '..', 'LICENSE'), join(root, 'packages', 'sdk', 'LICENSE'));
    const result = run(root, '--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packages\/sdk\/LICENSE düz dosya değil/);
  });
});

describe('pack-files --write', () => {
  it('eksik ve sapmış kopyaları kökten yazar', () => {
    const root = repo({ sdk: { manifest: library(), files: { NOTICE: 'eski\n' } } });
    const result = run(root, '--write');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /packages\/sdk\/LICENSE kökten yazıldı/);
    assert.equal(read(root, 'packages/sdk/LICENSE'), LICENSE);
    assert.equal(read(root, 'packages/sdk/NOTICE'), NOTICE);
    assert.equal(run(root, '--check').status, 0);
  });

  it('denetlenmeyen paketlerin LICENSE ve NOTICE dosyalarına dokunmaz', () => {
    const root = repo({ sdk: synced(), ...ungoverned });
    assert.equal(run(root, '--write').status, 0);
    assert.equal(read(root, 'packages/agent-sdk/LICENSE'), MIT);
    assert.equal(read(root, 'packages/upstream/LICENSE'), MIT);
    assert.equal(read(root, 'packages/upstream/NOTICE'), UPSTREAM_NOTICE);
  });

  it('güncel kopyayı yeniden yazmaz', () => {
    const root = repo({ sdk: synced() });
    const copy = join(root, 'packages', 'sdk', 'NOTICE');
    utimesSync(copy, 1_000_000, 1_000_000);
    const result = run(root, '--write');
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /yazıldı/);
    assert.equal(statSync(copy).mtimeMs, 1_000_000_000);
  });

  it('sembolik bağı düz dosyayla değiştirir, bağın hedefine yazmaz', () => {
    const root = repo({ sdk: { manifest: library(), files: { LICENSE } } });
    writeFileSync(join(root, 'elsewhere.txt'), 'dokunulmaz\n');
    symlinkSync(join('..', '..', 'elsewhere.txt'), join(root, 'packages', 'sdk', 'NOTICE'));
    assert.equal(run(root, '--write').status, 0);
    assert.ok(lstatSync(join(root, 'packages', 'sdk', 'NOTICE')).isFile());
    assert.equal(read(root, 'packages/sdk/NOTICE'), NOTICE);
    assert.equal(read(root, 'elsewhere.txt'), 'dokunulmaz\n');
  });

  it('elle düzeltilecek sorun kalırsa kırar', () => {
    const root = repo({ sdk: { manifest: library({ files: ['dist', 'NOTICE'] }) } });
    const result = run(root, '--write');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"files" LICENSE içermiyor/);
    assert.equal(read(root, 'packages/sdk/LICENSE'), LICENSE);
  });
});

describe('pack-files kullanım', () => {
  for (const args of [[], ['--check', '--write'], ['--fix']]) {
    it(`geçersiz argümanlar: ${JSON.stringify(args)}`, () => {
      assert.equal(run(repo(), ...args).status, 2);
    });
  }

  it('repo kökü dışında, kopya taşıyan paket dizininde bile çalışmaz', () => {
    const root = repo({ sdk: synced() });
    const result = run(join(root, 'packages', 'sdk'), '--check');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /pnpm-workspace\.yaml/);
  });

  it('bozuk package.json dosya yoluyla bildirilir', () => {
    const root = repo({ sdk: synced() });
    writeFileSync(join(root, 'packages', 'sdk', 'package.json'), '{');
    const result = run(root, '--check');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /packages\/sdk\/package\.json/);
  });
});
