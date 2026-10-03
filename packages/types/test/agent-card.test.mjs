import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as t from '../dist/index.js';

const WALLET = 'CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc';

const v1Card = (overrides = {}) => ({
  did: `did:aip:${WALLET}:summary-bot`,
  name: 'Summary Bot',
  version: '1.0.0',
  endpoint: 'https://agents.aip.test/a2a',
  type: 'Task',
  capabilities: [
    {
      id: 'text.summarize',
      description: 'Summarize Text',
      pricing: { amount: '0.10', token: 'USDC', network: 'solana' },
    },
  ],
  walletAddress: WALLET,
  ...overrides,
});

test('AipV1AgentCard: AIP kart biçimi doğrulanır', () => {
  const result = t.AipV1AgentCardSchema.safeParse(v1Card());
  assert.ok(result.success, JSON.stringify(result.error?.issues));
  assert.ok(t.AipV1AgentCardSchema.safeParse(v1Card({ walletAddress: undefined })).success);
});

test('AipV1AgentCard: AIP doğrulayıcısının reddettikleri reddedilir', () => {
  assert.ok(!t.AipV1AgentCardSchema.safeParse(v1Card({ did: 'aip:x' })).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(v1Card({ endpoint: 'javascript:alert(1)' })).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(v1Card({ endpoint: 'data:text/html,x' })).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(v1Card({ type: 'Bot' })).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(v1Card({ capabilities: [] })).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(v1Card({ name: '   ' })).success);
  const capability = (pricing) => ({ capabilities: [{ id: 'a', description: 'b', pricing }] });
  assert.ok(
    !t.AipV1AgentCardSchema.safeParse(v1Card(capability({ amount: '0.1', token: 'USDT', network: 'solana' }))).success,
  );
  assert.ok(
    !t.AipV1AgentCardSchema.safeParse(v1Card(capability({ amount: '0.1', token: 'USDC', network: 'base' }))).success,
  );
});

test('AipV1AgentCard: tutar ondalık sayı olmalı (kaynaktaki parseFloat açığı kapalı)', () => {
  const amount = (value) =>
    v1Card({
      capabilities: [{ id: 'a', description: 'b', pricing: { amount: value, token: 'USDC', network: 'solana' } }],
    });
  assert.ok(t.AipV1AgentCardSchema.safeParse(amount('12')).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(amount('1abc')).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(amount('-1')).success);
  assert.ok(!t.AipV1AgentCardSchema.safeParse(amount('')).success);
});
