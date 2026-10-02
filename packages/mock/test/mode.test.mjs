// Mock / gerçek geçişi: varsayılan live, mock yalnızca açıkça; production'da ayrıca izin ister.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedError } from '@squaresdk/solana-types';
import { ALLOW_MOCK_IN_PRODUCTION, createSquareApi, resolveApiMode } from '../dist/index.js';

test('mod çözümü', () => {
  assert.equal(resolveApiMode({}), 'live');
  assert.equal(resolveApiMode({ SQUARE_API_MODE: '' }), 'live');
  assert.equal(resolveApiMode({ SQUARE_API_MODE: 'mock' }), 'mock');
  assert.equal(resolveApiMode({ NEXT_PUBLIC_SQUARE_API_MODE: 'mock' }), 'mock');
  assert.equal(resolveApiMode({ SQUARE_API_MODE: 'mock', NEXT_PUBLIC_SQUARE_API_MODE: 'mock' }), 'mock');
  assert.throws(() => resolveApiMode({ SQUARE_API_MODE: 'mock', NEXT_PUBLIC_SQUARE_API_MODE: 'live' }), /farklı/);
  assert.throws(() => resolveApiMode({ SQUARE_API_MODE: 'simulated' }), /Geçersiz/);
});

test('mock açıkça istenince mock API döner', async () => {
  const api = createSquareApi({ env: { SQUARE_API_MODE: 'mock' }, mock: { step: 2 } });
  assert.equal(api.scenario.step, 2);
  assert.equal((await api.listAgents()).data.length, 1);
});

test('production\'da mock ayrıca izin ister', () => {
  assert.throws(() => createSquareApi({ env: { SQUARE_API_MODE: 'mock', NODE_ENV: 'production' } }), new RegExp(ALLOW_MOCK_IN_PRODUCTION));
  assert.doesNotThrow(() => createSquareApi({ env: { SQUARE_API_MODE: 'mock', NODE_ENV: 'production', [ALLOW_MOCK_IN_PRODUCTION]: '1' } }));
});

test('live: istemci ayarı ister; istemci BE-18\'e kadar NotImplemented', () => {
  assert.throws(() => createSquareApi({ env: {} }), /client\.baseUrl/);
  assert.throws(
    () => createSquareApi({ env: {}, client: { baseUrl: 'http://localhost:3000' } }),
    (e) => e instanceof NotImplementedError && e.issue === 'BE-18',
  );
});
