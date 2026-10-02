import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Connection } from '@solana/web3.js';
import { NotImplementedError } from '@squaresdk/solana-types';
import * as sdk from '../dist/index.js';

const spec = parse(readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8'));
const operationIds = Object.values(spec.paths).flatMap((item) =>
  Object.values(item).filter((op) => op && typeof op === 'object' && 'operationId' in op).map((op) => op.operationId),
);

test('SquareApi metotları OpenAPI operationId listesiyle aynı', () => {
  assert.deepEqual([...sdk.API_OPERATIONS].sort(), [...operationIds].sort());
});

test('SOURCE_PROGRAM_IDS, idl/ adresleriyle aynı', () => {
  for (const program of ['registry', 'policy', 'verifier', 'escrow']) {
    const idl = JSON.parse(readFileSync(new URL(`../../../idl/square_${program}_contract.json`, import.meta.url), 'utf8'));
    assert.equal(sdk.SOURCE_PROGRAM_IDS[program].toBase58(), idl.address);
    assert.equal(sdk.SQUARE_IDLS[program].metadata.name, idl.metadata.name);
  }
});

test('imzalar gövdesiz: NotImplementedError fırlatır', () => {
  const connection = new Connection('http://127.0.0.1:8899');
  for (const [fn, issue] of [
    [() => sdk.createSquareClient({ connection }), 'BE-08'],
    [() => sdk.createPda(sdk.SOURCE_PROGRAM_IDS), 'BE-08'],
    [() => sdk.specHash({}), 'BE-08'],
    [() => sdk.createApiClient({ baseUrl: 'http://localhost:3000' }), 'BE-18'],
  ]) {
    assert.throws(fn, (err) => err instanceof NotImplementedError && err.issue === issue);
  }
});

test('src/idl kopyaları idl/ ile aynı (Anchor gerektirmeyen kontrol)', () => {
  for (const program of ['registry', 'policy', 'verifier', 'escrow']) {
    const name = `square_${program}_contract`;
    const root = readFileSync(new URL(`../../../idl/${name}.json`, import.meta.url), 'utf8');
    const copy = readFileSync(new URL(`../src/idl/${name}.json`, import.meta.url), 'utf8');
    assert.equal(copy, root, `${name}.json kopyası güncel değil (interfaces/build-idl.sh)`);
    const types = readFileSync(new URL(`../src/idl/${name}.ts`, import.meta.url), 'utf8');
    const idl = JSON.parse(root);
    assert.ok(types.includes(`"address": "${idl.address}"`), `${name}.ts adresi farklı`);
    for (const ix of idl.instructions) {
      const camel = ix.name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      assert.ok(types.includes(`"name": "${camel}"`), `${name}.ts içinde ${camel} yok`);
    }
  }
});
