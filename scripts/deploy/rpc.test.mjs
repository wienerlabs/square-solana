import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RATE_LIMIT_RETRIES, backoffMs, patientFetch } from './rpc.mjs';

test('bekleme ikiye katlanır, 60 sn ile sınırlı', () => {
  assert.deepEqual([0, 1, 2, 5, 6, 7].map(backoffMs), [1_000, 2_000, 4_000, 32_000, 60_000, 60_000]);
});

test('429 yeniden denenir, diğer yanıtlar olduğu gibi döner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const statuses = [429, 429, 200];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: statuses[calls++] }));
  const pending = patientFetch('https://rpc', {});
  for (let i = 0; i < 2; i++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(backoffMs(i));
  }
  assert.equal((await pending).status, 200);
  assert.equal(calls, 3);
});

test('deneme hakkı bitince 429 döner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('', { status: 429 });
  });
  const pending = patientFetch('https://rpc', {});
  for (let i = 0; i < RATE_LIMIT_RETRIES; i++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(backoffMs(i));
  }
  assert.equal((await pending).status, 429);
  assert.equal(calls, RATE_LIMIT_RETRIES + 1);
});
