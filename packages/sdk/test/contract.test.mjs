import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import * as sdk from '../dist/index.js';

const spec = parse(readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8'));
const operationIds = Object.values(spec.paths).flatMap((item) =>
  Object.values(item)
    .filter((op) => op && typeof op === 'object' && 'operationId' in op)
    .map((op) => op.operationId),
);

test('SquareApi metotları OpenAPI operationId listesiyle aynı', () => {
  assert.deepEqual([...sdk.API_OPERATIONS].sort(), [...operationIds].sort());
});

test('SQUARE_IDLS, idl/ dosyalarıyla aynı', () => {
  for (const program of ['registry', 'policy', 'verifier', 'escrow']) {
    const idl = JSON.parse(
      readFileSync(new URL(`../../../idl/square_${program}_contract.json`, import.meta.url), 'utf8'),
    );
    assert.equal(sdk.SQUARE_IDLS[program].address, idl.address);
    assert.equal(sdk.SQUARE_IDLS[program].metadata.name, idl.metadata.name);
    assert.equal(sdk.SQUARE_IDLS[program].instructions.length, idl.instructions.length);
  }
});

test('SDK çalışma zamanı dışa aktarımları beklenen yüzeyle aynı (BE-35 + BE-08 + BC-28 + BC-34 + BE-14)', () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    'API_OPERATIONS',
    'MAX_COMPUTE_UNIT_LIMIT',
    'PACKET_DATA_SIZE',
    'SQUARE_IDLS',
    'TRAVEL_RULE_DOMAIN',
    'TX_COMPUTE_UNIT_LIMITS',
    'computeUnitLimitFor',
    'createLookupTableInstructions',
    'createPda',
    'createSquareClient',
    'specHashing',
    'squareLookupTableAddresses',
    'toIdlJson',
    'travelRule',
    'withComputeProfile',
    'workHash',
  ]);
});

test('src/idl kopyaları idl/ ile aynı', () => {
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
