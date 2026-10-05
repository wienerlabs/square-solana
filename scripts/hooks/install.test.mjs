import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOOKS_PATH, decide } from './install.mjs';

test('kanca dizini yalnızca git deposunda ve başka bir ayar yokken ayarlanıyor', () => {
  assert.equal(decide({ inWorkTree: false, current: '' }), 'no-repo');
  assert.equal(decide({ inWorkTree: true, current: '' }), 'set');
  assert.equal(decide({ inWorkTree: true, current: HOOKS_PATH }), 'already');
  assert.equal(decide({ inWorkTree: true, current: '.husky' }), 'custom');
});
