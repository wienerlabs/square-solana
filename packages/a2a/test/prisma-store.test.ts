import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import type { Message } from '@squaresdk/solana-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaTaskStore } from '../src/prisma-store.js';
import { TaskStoreError, type NewTask, type TaskStore } from '../src/store.js';
import { AGENT_RECORD, JOB_A, JOB_B, OTHER_AGENT_RECORD, SPEC_HASH } from './helpers/fixtures.js';

let db: IsolatedDatabase;
let store: TaskStore;

beforeAll(async () => {
  db = await startIsolatedDatabase();
  store = createPrismaTaskStore(db.client);
});

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.truncate();
});

const message = (id: string, text = 'iş tanımı'): Message => ({ messageId: id, role: 'ROLE_USER', parts: [{ text }] });

const newTask = (overrides: Partial<NewTask> = {}): NewTask => ({
  agentRecord: AGENT_RECORD,
  caller: 'kurum-a',
  contextId: JOB_A,
  job: JOB_A,
  specHash: SPEC_HASH,
  createHash: 'ab'.repeat(32),
  message: message('m-1'),
  statusAt: new Date('2026-10-03T12:00:00.000Z'),
  jobStatus: 'funded',
  jobSlot: 10,
  ...overrides,
});

describe('create', () => {
  it('görevi ve ilk mesajı yazar', async () => {
    const { task, created } = await store.create(newTask());
    expect(created).toBe(true);
    expect(task).toMatchObject({
      state: 'TASK_STATE_SUBMITTED',
      job: JOB_A,
      version: 0,
      jobStatus: 'funded',
      jobSlot: 10,
    });
    expect(await store.history(task.id)).toEqual([message('m-1')]);
  });

  it('aynı mesaj aynı içerikle tekrar gelirse aynı görevi döner', async () => {
    const first = await store.create(newTask());
    const second = await store.create(newTask());
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it('aynı mesaj kimliği farklı içerikle çakışma verir', async () => {
    await store.create(newTask());
    await expect(store.create(newTask({ createHash: 'cd'.repeat(32) }))).rejects.toMatchObject({ kind: 'message-id' });
  });

  it('bir job için aynı anda tek etkin görev', async () => {
    await store.create(newTask());
    const second = store.create(newTask({ caller: 'kurum-b', message: message('m-2') }));
    await expect(second).rejects.toBeInstanceOf(TaskStoreError);
    await expect(second).rejects.toMatchObject({ kind: 'active-task' });
  });

  it('eşzamanlı oluşturmalardan yalnızca biri kazanır', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => store.create(newTask({ caller: `c${i}`, message: message(`m-${i}`) }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('terminal görevden sonra aynı job için yeni görev açılabilir', async () => {
    const { task } = await store.create(newTask());
    await store.update(AGENT_RECORD, task.id, 0, { state: 'TASK_STATE_REJECTED', statusAt: new Date() });
    const again = await store.create(newTask({ message: message('m-2') }));
    expect(again.created).toBe(true);
  });
});

describe('update', () => {
  it('sürüm eşleşirse yazar ve sürümü artırır', async () => {
    const { task } = await store.create(newTask());
    const updated = await store.update(AGENT_RECORD, task.id, 0, {
      state: 'TASK_STATE_WORKING',
      statusAt: new Date('2026-10-03T12:01:00.000Z'),
      statusMessage: { messageId: 's-1', role: 'ROLE_AGENT', parts: [{ text: 'kabul edildi' }] },
      jobStatus: 'accepted',
    });
    expect(updated).toMatchObject({ state: 'TASK_STATE_WORKING', version: 1, jobStatus: 'accepted' });
    expect(updated.statusMessage?.parts).toEqual([{ text: 'kabul edildi' }]);
  });

  it('eski sürümle yazma çakışma verir', async () => {
    const { task } = await store.create(newTask());
    await store.update(AGENT_RECORD, task.id, 0, { state: 'TASK_STATE_WORKING', statusAt: new Date() });
    await expect(
      store.update(AGENT_RECORD, task.id, 0, { state: 'TASK_STATE_FAILED', statusAt: new Date() }),
    ).rejects.toMatchObject({ kind: 'version' });
  });

  it('artefaktları saklar', async () => {
    const { task } = await store.create(newTask());
    const artifact = { artifactId: 'a-1', parts: [{ url: 'https://agent.example/d/1', mediaType: 'text/plain' }] };
    const updated = await store.update(AGENT_RECORD, task.id, 0, { artifacts: [artifact] });
    expect((await store.get(AGENT_RECORD, task.id))?.artifacts).toEqual([artifact]);
    expect(updated.version).toBe(1);
  });

  it('UUID olmayan kimlik için görev yoktur', async () => {
    expect(await store.get(AGENT_RECORD, 'yok')).toBeNull();
    expect(await store.history('yok')).toEqual([]);
    await expect(store.update(AGENT_RECORD, 'yok', 0, {})).rejects.toMatchObject({ kind: 'not-found' });
    await expect(store.appendMessage('yok', message('m-1'))).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('durum mesajı temizlenebilir', async () => {
    const { task } = await store.create(newTask());
    const withMessage = await store.update(AGENT_RECORD, task.id, 0, {
      statusMessage: { messageId: 's-1', role: 'ROLE_AGENT', parts: [{ text: 'x' }] },
    });
    expect(withMessage.statusMessage).not.toBeNull();
    expect((await store.update(AGENT_RECORD, task.id, 1, { statusMessage: null })).statusMessage).toBeNull();
  });

  it("başka agent'ın görevi görünmez", async () => {
    const { task } = await store.create(newTask());
    expect(await store.get(OTHER_AGENT_RECORD, task.id)).toBeNull();
    await expect(
      store.update(OTHER_AGENT_RECORD, task.id, 0, { state: 'TASK_STATE_WORKING', statusAt: new Date() }),
    ).rejects.toMatchObject({
      kind: 'not-found',
    });
  });
});

describe('list ve history', () => {
  it('çağırana kapsamlı, durum zamanına göre azalan, imleçli', async () => {
    for (let i = 0; i < 5; i += 1) {
      const { task } = await store.create(
        newTask({ job: i % 2 === 0 ? JOB_A : JOB_B, contextId: `ctx-${i}`, message: message(`m-${i}`) }),
      );
      await store.update(AGENT_RECORD, task.id, 0, {
        state: 'TASK_STATE_FAILED',
        statusAt: new Date(Date.UTC(2026, 9, 3, 12, i)),
      });
    }
    await store.create(newTask({ caller: 'kurum-b', message: message('m-x') }));

    const page1 = await store.list(AGENT_RECORD, 'kurum-a', { pageSize: 2 });
    expect(page1.totalSize).toBe(5);
    expect(page1.tasks.map((t) => t.contextId)).toEqual(['ctx-4', 'ctx-3']);
    const page2 = await store.list(AGENT_RECORD, 'kurum-a', { pageSize: 2, after: page1.next ?? undefined });
    expect(page2.tasks.map((t) => t.contextId)).toEqual(['ctx-2', 'ctx-1']);
    const page3 = await store.list(AGENT_RECORD, 'kurum-a', { pageSize: 2, after: page2.next ?? undefined });
    expect(page3.tasks.map((t) => t.contextId)).toEqual(['ctx-0']);
    expect(page3.next).toBeNull();

    const filtered = await store.list(AGENT_RECORD, 'kurum-a', { pageSize: 10, contextId: 'ctx-1' });
    expect(filtered.tasks).toHaveLength(1);
    const byState = await store.list(AGENT_RECORD, 'kurum-b', { pageSize: 10, state: 'TASK_STATE_SUBMITTED' });
    expect(byState.tasks).toHaveLength(1);
    const after = await store.list(AGENT_RECORD, 'kurum-a', {
      pageSize: 10,
      statusAfter: new Date(Date.UTC(2026, 9, 3, 12, 3)),
    });
    expect(after.tasks.map((t) => t.contextId)).toEqual(['ctx-4', 'ctx-3']);
  });

  it('mesaj geçmişi sıralı, aynı mesaj ikinci kez eklenmez, sınır uygulanır', async () => {
    const { task } = await store.create(newTask());
    expect(await store.appendMessage(task.id, message('m-2', 'ek bilgi'))).toBe(true);
    expect(await store.appendMessage(task.id, message('m-2', 'ek bilgi'))).toBe(false);
    expect((await store.history(task.id)).map((m) => m.messageId)).toEqual(['m-1', 'm-2']);
    expect((await store.history(task.id, 1)).map((m) => m.messageId)).toEqual(['m-2']);
    expect(await store.history(task.id, 0)).toEqual([]);
  });
});
