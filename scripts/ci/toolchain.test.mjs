import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { anchorToolchain, checkWorkflow } from './toolchain.mjs';

const toolchain = { anchor: '1.2.0', solana: '4.1.2' };

test("Anchor.toml'daki [toolchain] okunuyor", () => {
  const repo = anchorToolchain(readFileSync(new URL('../../Anchor.toml', import.meta.url), 'utf8'));
  assert.match(repo.anchor, /^\d+\.\d+\.\d+$/);
  assert.match(repo.solana, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(
    anchorToolchain(
      '[features]\nanchor_version = "0.1.0"\n[toolchain]\nanchor_version = "1.2.0"\nsolana_version = "4.1.2"\n',
    ),
    toolchain,
  );
  assert.throws(() => anchorToolchain('[toolchain]\nanchor_version = "1.2.0"\n'), /solana_version/);
});

test('aynı sürümler geçiyor, farklı olan bildiriliyor', () => {
  const ok = `env:\n  AGAVE_VERSION: 4.1.2\n  ANCHOR_VERSION: '1.2.0'\n  IMAGE: solanafoundation/solana-verifiable-build:4.1.2@sha256:ab\n`;
  assert.deepEqual(checkWorkflow('a.yml', ok, toolchain), { errors: [], pins: 3 });
  const drift = `env:\n  AGAVE_VERSION: 4.2.0\n  ANCHOR_VERSION: 1.2.0\n  IMAGE: solanafoundation/solana-verifiable-build:4.0.3\n`;
  assert.deepEqual(checkWorkflow('b.yml', drift, toolchain).errors, [
    'b.yml: AGAVE_VERSION 4.2.0, Anchor.toml [toolchain] 4.1.2',
    'b.yml: solana-verifiable-build imajı 4.0.3, Anchor.toml [toolchain] 4.1.2',
  ]);
  assert.deepEqual(checkWorkflow('c.yml', 'jobs: {}\n', toolchain), { errors: [], pins: 0 });
});
