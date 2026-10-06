import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as t from '../dist/index.js';

const WALLET = 'GkBszSapkCQ9xwrLvhtTHNFkEXoC68KJp54MZ5chcYBe';

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

const squareCard = (overrides = {}) => ({
  type: t.AGENT_CARD_TYPE,
  name: 'Metin Ajanı',
  description: 'Metin istatistikleri',
  url: 'https://agent.square.test/a2a',
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 'text.stats', name: 'Metin istatistiği', description: 'Sayımlar', tags: ['text'] }],
  services: [{ name: 'A2A', endpoint: 'https://agent.square.test/a2a', version: '1.0' }],
  registrations: [{ agentRegistry: `solana:${'1'.repeat(32)}:${WALLET}`, agentId: WALLET }],
  ...overrides,
});

test('AgentCard: A2A v1.0 supportedInterfaces isteğe bağlı ve url ile eşleşmeli', () => {
  assert.ok(t.AgentCardSchema.safeParse(squareCard()).success);
  const entry = (url) => ({ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' });
  const ok = t.AgentCardSchema.safeParse(squareCard({ supportedInterfaces: [entry('https://agent.square.test/a2a')] }));
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  assert.deepEqual(ok.data.supportedInterfaces, [entry('https://agent.square.test/a2a')]);
  assert.ok(
    !t.AgentCardSchema.safeParse(squareCard({ supportedInterfaces: [entry('https://other.test/a2a')] })).success,
  );
  assert.ok(!t.AgentCardSchema.safeParse(squareCard({ supportedInterfaces: [] })).success);
  const grpc = { ...entry('https://agent.square.test/a2a'), protocolBinding: 'GRPC' };
  assert.ok(!t.AgentCardSchema.safeParse(squareCard({ supportedInterfaces: [grpc] })).success);
  const http = entry('http://agent.square.test/a2a');
  assert.ok(!t.AgentCardSchema.safeParse(squareCard({ supportedInterfaces: [http] })).success);
});
