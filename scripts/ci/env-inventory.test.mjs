import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isSecret, mismatches, observabilityKeys, parseEnvExample, schemaKeys, services } from './env-inventory.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('secret sınıflaması: anahtarlar, parolalar, bağlantı dizgeleri; hash, yol ve herkese açık anahtar değil', () => {
  for (const name of [
    'KEEPER_SECRET_KEY',
    'DATABASE_URL',
    'SCREENER_AUTHORITY_KEYPAIR',
    'HELIUS_API_KEY',
    'X402_FACILITATOR_TOKEN',
    'API_RPC_URLS',
    'ALERT_WEBHOOK_URL',
  ]) {
    assert.ok(isSecret(name), name);
  }
  for (const name of [
    'PROVER_API_KEY_SHA256',
    'SCREENER_AUTHORITY_KEYPAIR_PATH',
    'STRIPE_PUBLISHABLE_KEY',
    'API_SECRET_BOX_ACTIVE_KEY',
    'KEEPER_PORT',
    'LOG_LEVEL',
  ]) {
    assert.ok(!isSecret(name), name);
  }
});

test('şema anahtarları ve örnek dosyası ayrıştırılır', () => {
  assert.deepEqual(schemaKeys('z.object({\n  FOO_BAR: x,\n  lower: y,\n  BAZ_QUX: z,\n})'), ['FOO_BAR', 'BAZ_QUX']);
  const vars = parseEnvExample('# --- Sunucu (zorunlu) ---\n# açıklama\nFOO_PORT=\n\nBAR_X=\n');
  assert.deepEqual(vars, [
    { name: 'FOO_PORT', section: 'Sunucu (zorunlu)', note: 'açıklama' },
    { name: 'BAR_X', section: 'Sunucu (zorunlu)', note: '' },
  ]);
});

test('bütün servislerde şema ile .env.example uyumlu', () => {
  const shared = observabilityKeys(ROOT);
  assert.ok(shared.includes('LOG_LEVEL'));
  assert.deepEqual(
    services(ROOT).flatMap((app) => mismatches(ROOT, app, shared)),
    [],
  );
});
