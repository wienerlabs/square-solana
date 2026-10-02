import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedError } from '@squaresdk/solana-types';
import * as identity from '../dist/index.js';

test('identity imzaları gövdesiz (BE-09)', async () => {
  assert.throws(() => identity.parseDidAip('did:aip:x'), (e) => e instanceof NotImplementedError && e.issue === 'BE-09');
  assert.throws(() => identity.verifyAgentCardHash(new Uint8Array(), new Uint8Array(32)), NotImplementedError);
  await assert.rejects(identity.resolveDid('did:aip:x', {}), NotImplementedError);
});
