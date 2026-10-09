import { TaskStoreError, type NewTask, type TaskStore } from '@squaresdk/solana-a2a';
import type { Message } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryTaskStore } from '../src/memory-store.js';

const AGENT = 'agent-record';
const message = (messageId: string, text = messageId): Message => ({
  messageId,
  role: 'ROLE_USER',
  parts: [{ text }],
});

const newTask = (overrides: Partial<NewTask> = {}): NewTask => ({
  agentRecord: AGENT,
  caller: 'api-key:a',
  job: 'job-1',
  specHash: 'ab'.repeat(32),
  createHash: 'cd'.repeat(32),
  message: message('m-1'),
  statusAt: new Date('2026-10-07T10:00:00Z'),
  jobStatus: 'funded',
  jobSlot: 10,
  ...overrides,
});

const kind = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof TaskStoreError ? error.kind : 'other';
  }
  return null;
};

let store: TaskStore;
let clock: number;

beforeEach(() => {
  clock = Date.parse('2026-10-07T10:00:00Z');
  store = createMemoryTaskStore(() => new Date((clock += 1_000)));
});

describe('createMemoryTaskStore', () => {
  it('görevi açar; aynı mesajla ikinci çağrı aynı görevi döner, farklı içerik reddedilir', async () => {
    const first = await store.create(newTask());
    expect(first.created).toBe(true);
    expect(first.task).toMatchObject({
      state: 'TASK_STATE_SUBMITTED',
      contextId: 'job-1',
      version: 0,
      statusMessage: null,
      artifacts: [],
    });
    const again = await store.create(newTask());
    expect(again).toEqual({ task: first.task, created: false });
    expect(await kind(store.create(newTask({ createHash: 'ef'.repeat(32) })))).toBe('message-id');
    expect(await kind(store.create(newTask({ job: 'job-2' })))).toBe('message-id');
    expect(await store.history(first.task.id)).toEqual([message('m-1')]);
  });

  it('job başına tek etkin görev; terminal olunca yenisi açılır', async () => {
    const { task } = await store.create(newTask());
    expect(await kind(store.create(newTask({ message: message('m-2') })))).toBe('active-task');
    await store.update(AGENT, task.id, 0, { state: 'TASK_STATE_COMPLETED' });
    expect((await store.create(newTask({ message: message('m-2') }))).created).toBe(true);
    expect((await store.create(newTask({ agentRecord: 'other', message: message('m-3') }))).created).toBe(true);
  });

  it('get ve findCreated yalnızca sahibi olan agent için döner; dönen kayıt kopyadır', async () => {
    const { task } = await store.create(newTask());
    expect(await store.get('other', task.id)).toBeNull();
    expect(await store.get(AGENT, 'yok')).toBeNull();
    const fetched = (await store.get(AGENT, task.id))!;
    fetched.state = 'TASK_STATE_FAILED';
    expect((await store.get(AGENT, task.id))!.state).toBe('TASK_STATE_SUBMITTED');
    expect((await store.findCreated(AGENT, 'api-key:a', 'm-1'))!.id).toBe(task.id);
    expect(await store.findCreated(AGENT, 'api-key:b', 'm-1')).toBeNull();
  });

  it('update sürümü denetler, alanları yazar ve mesajı aynı adımda geçmişe ekler', async () => {
    const { task } = await store.create(newTask());
    const statusMessage = message('s-1', 'çalışıyor');
    const updated = await store.update(
      AGENT,
      task.id,
      0,
      {
        state: 'TASK_STATE_WORKING',
        statusAt: new Date('2026-10-07T10:05:00Z'),
        statusMessage,
        artifacts: [{ artifactId: 'delivery', parts: [{ text: 'x' }] }],
        jobStatus: 'accepted',
        jobSlot: null,
      },
      statusMessage,
    );
    expect(updated).toMatchObject({ state: 'TASK_STATE_WORKING', version: 1, jobStatus: 'accepted', jobSlot: null });
    expect(updated.statusMessage).toEqual(statusMessage);
    expect(await store.history(task.id)).toHaveLength(2);
    expect(await kind(store.update(AGENT, task.id, 0, { state: 'TASK_STATE_FAILED' }))).toBe('version');
    expect(await kind(store.update('other', task.id, 1, {}))).toBe('not-found');
    expect(await kind(store.update(AGENT, task.id, 1, {}, statusMessage))).toBe('message-id');
    expect((await store.get(AGENT, task.id))!.version).toBe(1);
    const cleared = await store.update(AGENT, task.id, 1, { statusMessage: null });
    expect(cleared).toMatchObject({ statusMessage: null, state: 'TASK_STATE_WORKING', version: 2 });
  });

  it('appendMessage tekrar eden kimliği eklemez, sınırı uygular, bekleyenleri işaretler', async () => {
    const { task } = await store.create(newTask());
    expect(await store.appendMessage(task.id, message('m-1'))).toBe(false);
    expect(await store.appendMessage(task.id, message('m-2'), { maxMessages: 3, pending: true })).toBe(true);
    expect(await store.appendMessage(task.id, message('m-3'), { maxMessages: 3, pending: true })).toBe(true);
    expect(await kind(store.appendMessage(task.id, message('m-4'), { maxMessages: 3 }))).toBe('message-limit');
    expect(await kind(store.appendMessage('yok', message('m-5')))).toBe('not-found');
    expect((await store.pendingMessages(task.id)).map((m) => m.messageId)).toEqual(['m-2', 'm-3']);
    await store.markProcessed(task.id, 'm-2');
    expect((await store.pendingMessages(task.id)).map((m) => m.messageId)).toEqual(['m-3']);
    expect(await store.message(task.id, 'm-3')).toEqual({ message: message('m-3'), pending: true });
    expect(await store.message(task.id, 'yok')).toBeNull();
    expect(await store.message('yok', 'm-1')).toBeNull();
    expect(await store.pendingMessages('yok')).toEqual([]);
    await store.markProcessed('yok', 'm-1');
    expect((await store.history(task.id, 2)).map((m) => m.messageId)).toEqual(['m-2', 'm-3']);
    expect(await store.history(task.id, 0)).toEqual([]);
    expect(await store.history('yok')).toEqual([]);
  });

  it('list çağırana ve süzgeçlere göre, yeniden eskiye ve imleçle sayfalar', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { task } = await store.create(
        newTask({
          job: `job-${i}`,
          message: message(`m-${i}`),
          statusAt: new Date(Date.parse('2026-10-07T10:00:00Z') + (i % 3) * 60_000),
        }),
      );
      ids.push(task.id);
    }
    await store.create(newTask({ caller: 'api-key:b', job: 'job-x', message: message('m-x') }));
    await store.update(AGENT, ids[0]!, 0, {
      state: 'TASK_STATE_COMPLETED',
      artifacts: [{ artifactId: 'delivery', parts: [{ text: 'x' }] }],
    });

    const first = await store.list(AGENT, 'api-key:a', { pageSize: 2 });
    expect(first.totalSize).toBe(5);
    expect(first.tasks).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await store.list(AGENT, 'api-key:a', { pageSize: 2, after: first.next! });
    const third = await store.list(AGENT, 'api-key:a', { pageSize: 2, after: second.next! });
    expect(third.next).toBeNull();
    const seen = [...first.tasks, ...second.tasks, ...third.tasks];
    expect(new Set(seen.map((t) => t.id)).size).toBe(5);
    const order = seen.map((t) => t.statusAt.getTime());
    expect([...order].sort((a, b) => b - a)).toEqual(order);

    expect(
      (await store.list(AGENT, 'api-key:a', { pageSize: 10, contextId: 'job-1' })).tasks.map((t) => t.job),
    ).toEqual(['job-1']);
    const completed = await store.list(AGENT, 'api-key:a', { pageSize: 10, state: 'TASK_STATE_COMPLETED' });
    expect(completed.tasks.map((t) => t.id)).toEqual([ids[0]]);
    expect(completed.tasks[0]!.artifacts).toEqual([]);
    const withArtifacts = await store.list(AGENT, 'api-key:a', {
      pageSize: 10,
      state: 'TASK_STATE_COMPLETED',
      withArtifacts: true,
    });
    expect(withArtifacts.tasks[0]!.artifacts).toHaveLength(1);
    const recent = await store.list(AGENT, 'api-key:a', {
      pageSize: 10,
      statusAfter: new Date('2026-10-07T10:02:00Z'),
    });
    expect(recent.totalSize).toBe(1);
  });

  it('active yalnızca terminal olmayanları açılış sırasıyla ve artefaktsız verir', async () => {
    const a = await store.create(newTask({ job: 'job-a', message: message('a') }));
    const b = await store.create(newTask({ job: 'job-b', message: message('b') }));
    await store.update(AGENT, b.task.id, 0, { artifacts: [{ artifactId: 'x', parts: [{ text: 'x' }] }] });
    const c = await store.create(newTask({ job: 'job-c', message: message('c') }));
    await store.update(AGENT, c.task.id, 0, { state: 'TASK_STATE_REJECTED' });
    const active = await store.active(AGENT);
    expect(active.map((t) => t.id)).toEqual([a.task.id, b.task.id]);
    expect(active[1]!.artifacts).toEqual([]);
    expect(await store.active('other')).toEqual([]);
  });
});
