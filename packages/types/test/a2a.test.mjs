import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as t from '../dist/index.js';

const JOB = '5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT';
const HASH = 'ab'.repeat(32);
const NOW = '2026-10-03T12:00:00.000Z';

test('A2A sürümü ve görev durumları v1.0 (ProtoJSON enum adları)', () => {
  assert.equal(t.A2A_PROTOCOL_VERSION, '1.0');
  assert.deepEqual(t.TaskStateSchema.options, [
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_REJECTED',
    'TASK_STATE_AUTH_REQUIRED',
  ]);
  assert.deepEqual(t.RoleSchema.options, ['ROLE_USER', 'ROLE_AGENT']);
  assert.deepEqual(
    [...t.TERMINAL_TASK_STATES].sort(),
    ['TASK_STATE_CANCELED', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].sort(),
  );
  assert.deepEqual([...t.INTERRUPTED_TASK_STATES].sort(), ['TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_INPUT_REQUIRED']);
});

test('Part: text, raw, url ya da data alanlarından tam olarak biri', () => {
  assert.ok(t.PartSchema.safeParse({ text: 'merhaba' }).success);
  assert.ok(t.PartSchema.safeParse({ data: { spec: 1 }, mediaType: 'application/json' }).success);
  assert.ok(
    t.PartSchema.safeParse({ url: 'https://agent.example/d/1', mediaType: 'text/plain', filename: 'a.txt' }).success,
  );
  assert.ok(t.PartSchema.safeParse({ raw: 'aGVsbG8=' }).success);
  assert.ok(!t.PartSchema.safeParse({}).success);
  assert.ok(!t.PartSchema.safeParse({ text: 'a', url: 'https://x.example' }).success);
  assert.ok(!t.PartSchema.safeParse({ raw: 'not base64!' }).success);
});

test('Message: messageId, rol ve en az bir parça zorunlu', () => {
  const ok = { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'x' }] };
  assert.ok(t.MessageSchema.safeParse(ok).success);
  assert.ok(!t.MessageSchema.safeParse({ ...ok, messageId: '' }).success);
  assert.ok(!t.MessageSchema.safeParse({ ...ok, parts: [] }).success);
  assert.ok(!t.MessageSchema.safeParse({ ...ok, role: 'user' }).success);
});

test('Task: kimlik, durum ve Square meta verisi', () => {
  const task = {
    id: '6f3b2a10-9c1d-4e5f-8a7b-0c1d2e3f4a5b',
    contextId: JOB,
    status: { state: 'TASK_STATE_WORKING', timestamp: NOW },
    artifacts: [],
    metadata: { square: { job: JOB, specHash: HASH, jobStatus: 'accepted' } },
  };
  assert.ok(t.TaskSchema.safeParse(task).success);
  assert.ok(t.SquareTaskMetadataSchema.safeParse(task.metadata.square).success);
  assert.ok(!t.SquareTaskMetadataSchema.safeParse({ job: JOB, specHash: HASH.toUpperCase() }).success);
  assert.ok(!t.TaskSchema.safeParse({ ...task, status: { state: 'working', timestamp: NOW } }).success);
});

test('StreamResponse ve SendMessageResponse: tek bir yük', () => {
  const status = { taskId: 't', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED', timestamp: NOW } };
  assert.ok(t.StreamResponseSchema.safeParse({ statusUpdate: status }).success);
  assert.ok(
    t.StreamResponseSchema.safeParse({
      artifactUpdate: { taskId: 't', contextId: 'c', artifact: { artifactId: 'a', parts: [{ text: 'x' }] } },
    }).success,
  );
  assert.ok(!t.StreamResponseSchema.safeParse({}).success);
  assert.ok(
    !t.StreamResponseSchema.safeParse({
      statusUpdate: status,
      message: { messageId: 'm', role: 'ROLE_AGENT', parts: [{ text: 'x' }] },
    }).success,
  );
  assert.ok(!t.SendMessageResponseSchema.safeParse({}).success);
});

test('istek parametreleri', () => {
  const message = { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'x' }] };
  assert.ok(t.SendMessageRequestSchema.safeParse({ message, configuration: { returnImmediately: true } }).success);
  assert.ok(!t.SendMessageRequestSchema.safeParse({ configuration: {} }).success);
  assert.ok(t.GetTaskRequestSchema.safeParse({ id: 't', historyLength: 0 }).success);
  assert.ok(!t.GetTaskRequestSchema.safeParse({ id: 't', historyLength: -1 }).success);
  assert.ok(t.CancelTaskRequestSchema.safeParse({ id: 't' }).success);
  assert.ok(t.SubscribeToTaskRequestSchema.safeParse({ id: 't' }).success);
  assert.ok(t.ListTasksRequestSchema.safeParse({ pageSize: 100, status: 'TASK_STATE_WORKING' }).success);
  assert.ok(!t.ListTasksRequestSchema.safeParse({ pageSize: 101 }).success);
});

test('JSON-RPC 2.0 zarfı ve A2A hata kodları (spec §5.4)', () => {
  assert.ok(
    t.JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 't' } }).success,
  );
  assert.ok(!t.JsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', id: 1, method: 'GetTask' }).success);
  assert.deepEqual(t.A2A_ERROR_CODES, {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    taskNotFound: -32001,
    taskNotCancelable: -32002,
    pushNotificationNotSupported: -32003,
    unsupportedOperation: -32004,
    contentTypeNotSupported: -32005,
    invalidAgentResponse: -32006,
    extendedAgentCardNotConfigured: -32007,
    extensionSupportRequired: -32008,
    versionNotSupported: -32009,
  });
});

test("job durumu → görev durumu: görev agent'ın işidir, settlement görev durumunu değiştirmez", () => {
  assert.deepEqual(t.JOB_STATUS_TO_TASK_STATE, {
    open: 'TASK_STATE_SUBMITTED',
    funded: 'TASK_STATE_SUBMITTED',
    accepted: 'TASK_STATE_WORKING',
    delivered: 'TASK_STATE_COMPLETED',
    disputed: 'TASK_STATE_COMPLETED',
    resolved: 'TASK_STATE_COMPLETED',
    released: 'TASK_STATE_COMPLETED',
    refunded: 'TASK_STATE_COMPLETED',
    cancelled: 'TASK_STATE_CANCELED',
  });
});
