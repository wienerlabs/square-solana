import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as t from '../dist/index.js';

const ADDR = 'A8osQqNBGBFB2j1PdLwhANRNzjCYjJKsYVKbbrR75FbZ';
const HASH = 'ab'.repeat(32);

test('U64: ondalık string, aralık kontrolü', () => {
  assert.ok(t.U64.safeParse('18446744073709551615').success);
  assert.ok(!t.U64.safeParse('18446744073709551616').success);
  assert.ok(!t.U64.safeParse('01').success);
  assert.ok(!t.U64.safeParse(5).success);
});

test('Address ve Hex32', () => {
  assert.ok(t.Address.safeParse(ADDR).success);
  assert.ok(!t.Address.safeParse('0OIl').success);
  assert.ok(t.Hex32.safeParse(HASH).success);
  assert.ok(!t.Hex32.safeParse(HASH.toUpperCase()).success);
});

test('DisputeResolution: kind ile ayrılır', () => {
  assert.ok(t.DisputeResolutionSchema.safeParse({ kind: 'split', agentAmount: '10' }).success);
  assert.ok(!t.DisputeResolutionSchema.safeParse({ kind: 'split' }).success);
  assert.ok(t.DisputeResolutionSchema.safeParse({ kind: 'favorAgent' }).success);
});

test('InstructionCall: IDL argümanlarıyla doğrulanır', () => {
  const ok = t.InstructionCallSchema.safeParse({
    program: 'escrow',
    instruction: 'createJob',
    args: { specHash: HASH, amount: '1000000', deadline: 1_900_000_000, challengePeriod: '86400' },
  });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const wrongProgram = t.InstructionCallSchema.safeParse({
    program: 'policy',
    instruction: 'createJob',
    args: { specHash: HASH, amount: '1', deadline: 1, challengePeriod: '1' },
  });
  assert.ok(!wrongProgram.success);
});

test('envelopeSchema: başarı ve hata kolları', () => {
  const env = t.envelopeSchema(t.HealthSchema);
  const meta = { requestId: 'r1', page: null, limit: null, total: null };
  assert.ok(
    env.safeParse({ success: true, data: { status: 'ok', version: '0.1.0', checks: {} }, error: null, meta }).success,
  );
  const error = {
    code: 'program_error',
    message: 'x',
    programError: { program: 'escrow', code: 6000, name: 'InvalidStatus' },
    details: null,
  };
  assert.ok(env.safeParse({ success: false, data: null, error, meta }).success);
  assert.ok(!env.safeParse({ success: true, data: null, error, meta }).success);
});

test('JOB_STATUS_TO_TASK_STATE her job durumunu kapsar', () => {
  assert.deepEqual(Object.keys(t.JOB_STATUS_TO_TASK_STATE).sort(), [...t.JobStatusSchema.options].sort());
});

test('IDL_PROGRAMS: hata kodları 6000 ile başlar ve ardışık', () => {
  for (const p of Object.values(t.IDL_PROGRAMS)) {
    p.errors.forEach((e, i) => assert.equal(e.code, 6000 + i));
  }
});

test('x402 uç nokta şemaları: yol, sıfırdan büyük tutar, kısmi güncelleme', () => {
  const endpoint = {
    name: 'Rapor',
    path: '/v1/report',
    description: null,
    amount: '250000',
    mint: ADDR,
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    payTo: ADDR,
    enabled: true,
  };
  assert.ok(t.X402EndpointCreateSchema.safeParse(endpoint).success);
  assert.ok(!t.X402EndpointCreateSchema.safeParse({ ...endpoint, amount: '0' }).success);
  assert.ok(!t.X402EndpointCreateSchema.safeParse({ ...endpoint, path: 'v1/report' }).success);
  assert.ok(!t.X402EndpointCreateSchema.safeParse({ ...endpoint, path: '/v1/report?x=1' }).success);
  assert.ok(!t.X402EndpointCreateSchema.safeParse({ ...endpoint, network: 'solana' }).success);
  assert.ok(t.X402EndpointUpdateSchema.safeParse({ enabled: false }).success);
  assert.ok(!t.X402EndpointUpdateSchema.safeParse({}).success);
  assert.ok(!t.X402EndpointUpdateSchema.safeParse({ amount: '0' }).success);
  assert.ok(t.ApiKeyScopeSchema.safeParse('x402:serve').success);
  const report = {
    fingerprint: `svm:${HASH}`,
    transaction: '1'.repeat(64),
    network: endpoint.network,
    asset: ADDR,
    amount: '1',
    payer: ADDR,
    payTo: ADDR,
    settledAt: 1,
  };
  assert.ok(t.X402PaymentReportSchema.safeParse(report).success);
  assert.ok(!t.X402PaymentReportSchema.safeParse({ ...report, fingerprint: HASH }).success);
});
