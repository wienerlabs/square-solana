// SDK referansının bütünlüğü: `@squaresdk/solana-sdk`'nin her dışa aktarımı ve üyesi açıklamalı (BE-31).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undocumented } from './site.mjs';

test('SDK’nın açıklaması olmayan dışa aktarımı yok', async () => {
  assert.deepEqual(await undocumented(), []);
});
