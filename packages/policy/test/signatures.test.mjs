import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedError } from '@squaresdk/solana-types';
import * as policy from '../dist/index.js';

test('policy imzaları gövdesiz (BE-10)', () => {
  assert.throws(() => policy.generatePolicySalt(), (e) => e instanceof NotImplementedError && e.issue === 'BE-10');
  assert.throws(() => policy.buildBuyerTree([]), NotImplementedError);
  assert.throws(() => policy.createRemoteProver({ baseUrl: 'x', apiKey: 'y' }), NotImplementedError);
});
