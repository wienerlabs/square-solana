import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import type { StreamResponse } from '@squaresdk/solana-types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { A2aError, ERROR_INFO_TYPE } from '../src/errors.js';
import { JOB_A, JOB_B, JOB_C, JOB_D, OTHER_AGENT_RECORD } from './helpers/fixtures.js';
import { Harness, KEY_A, KEY_B, LIMITS, openingMessage, until } from './helpers/harness.js';

let db: IsolatedDatabase;
let h: Harness;

beforeAll(async () => {
  db = await startIsolatedDatabase();
});

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.truncate();
  h = new Harness(db);
  await h.start();
});

afterEach(async () => {
  await h.stop();
});

const reason = (error: unknown) =>
  ((error as A2aError).data?.find((d) => d['@type'] === ERROR_INFO_TYPE) as { reason?: string } | undefined)?.reason;

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(h.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0', 'x-api-key': KEY_A, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as { error?: { code: number }; result?: unknown } };
}

describe('protokol', () => {
  it('A2A-Version yoksa 0.3 sayılır ve -32009 döner', async () => {
    const { json } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
      { 'a2a-version': '' },
    );
    expect(json.error?.code).toBe(-32009);
  });

  it('sürüm sorgu parametresiyle de verilebilir', async () => {
    const response = await fetch(`${h.url}?A2A-Version=1.0`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY_A },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
    });
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32001);
  });

  it('kimlik yoksa 401', async () => {
    const { status, json } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
      { 'x-api-key': '' },
    );
    expect(status).toBe(401);
    expect(json.error?.code).toBe(-32000);
  });

  it('bilinmeyen yöntem, push yapılandırması ve genişletilmiş kart', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} })).json.error?.code).toBe(-32601);
    expect(
      (await rpc({ jsonrpc: '2.0', id: 2, method: 'CreateTaskPushNotificationConfig', params: {} })).json.error?.code,
    ).toBe(-32003);
    expect((await rpc({ jsonrpc: '2.0', id: 3, method: 'GetExtendedAgentCard' })).json.error?.code).toBe(-32007);
  });

  it('JSON değil, zarf geçersiz, gövde büyük, içerik tipi yanlış ya da yöntem GET', async () => {
    expect((await rpc('{')).json.error?.code).toBe(-32700);
    expect((await rpc({ jsonrpc: '2.0', method: 'GetTask' })).json.error?.code).toBe(-32600);
    const big = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'GetTask',
      params: { id: 'x'.repeat(LIMITS.maxBodyBytes) },
    });
    expect(big.status).toBe(413);
    const text = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'a2a-version': '1.0', 'x-api-key': KEY_A },
      body: '{}',
    });
    expect(text.status).toBe(415);
    expect((await fetch(h.url)).status).toBe(405);
  });

  it('geçersiz parametre -32602', async () => {
    await expect(h.client().getTask({ id: '' })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('görev açma', () => {
  it('returnImmediately ile SUBMITTED görev; GetTask ve meta veri', async () => {
    await h.openJob(JOB_A, 'a');
    const { task } = await h
      .client()
      .sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    expect(task).toMatchObject({ contextId: JOB_A, status: { state: 'TASK_STATE_SUBMITTED' } });
    expect(task?.metadata?.square).toMatchObject({ job: JOB_A, jobStatus: 'funded', slot: 1 });
    const fetched = await h.client().getTask({ id: task!.id });
    expect(fetched.id).toBe(task!.id);
    expect(fetched.history?.map((m) => m.messageId)).toEqual(['m-a']);
    expect((await h.client().getTask({ id: task!.id, historyLength: 0 })).history).toBeUndefined();
  });

  it('aynı mesaj aynı görevi döner; aynı kimlik farklı içerik çakışır', async () => {
    await h.openJob(JOB_A, 'a');
    const first = await h
      .client()
      .sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    const again = await h
      .client()
      .sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    expect(again.task?.id).toBe(first.task?.id);
    const conflicting = { ...openingMessage(JOB_A, 'a'), parts: [{ text: 'başka içerik' }] };
    await expect(
      h.client().sendMessage({ message: conflicting, configuration: { returnImmediately: true } }),
    ).rejects.toSatisfy((e) => reason(e) === 'MESSAGE_ID_CONFLICT');
  });

  it("job'un etkin görevi varken ikinci görev açılmaz", async () => {
    await h.openJob(JOB_A, 'a');
    await h.client().sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    await expect(
      h
        .client(KEY_B)
        .sendMessage({ message: openingMessage(JOB_A, 'a', 'm-b'), configuration: { returnImmediately: true } }),
    ).rejects.toSatisfy((e) => reason(e) === 'JOB_HAS_ACTIVE_TASK');
  });

  it("başka agent'ın job'u ve push yapılandırması reddedilir", async () => {
    await h.openJob(JOB_B, 'b', OTHER_AGENT_RECORD);
    await expect(
      h.client().sendMessage({ message: openingMessage(JOB_B, 'b'), configuration: { returnImmediately: true } }),
    ).rejects.toSatisfy((e) => reason(e) === 'JOB_NOT_FOR_AGENT');
    await h.openJob(JOB_A, 'a');
    await expect(
      h
        .client()
        .sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { taskPushNotificationConfig: {} } }),
    ).rejects.toMatchObject({ code: -32003 });
  });

  it('istemci mesajı ROLE_USER olmalı', async () => {
    await h.openJob(JOB_A, 'a');
    await expect(
      h.client().sendMessage({ message: { ...openingMessage(JOB_A, 'a'), role: 'ROLE_AGENT' } }),
    ).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('görev yalnızca onu açan çağırana görünür', async () => {
    await h.openJob(JOB_A, 'a');
    const { task } = await h
      .client()
      .sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    await expect(h.client(KEY_B).getTask({ id: task!.id })).rejects.toMatchObject({ code: -32001 });
    await expect(h.client(KEY_B).cancelTask({ id: task!.id })).rejects.toMatchObject({ code: -32001 });
    expect((await h.client(KEY_B).listTasks({})).tasks).toEqual([]);
  });
});

describe('agent akışı ve zincir', () => {
  it('bloklayan SendMessage görev bitince döner; artefakt ve geçmiş', async () => {
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => {
      await h.chain.setStatus(JOB_A, 'accepted');
      await context.working('iş kabul edildi');
      await context.addArtifact({
        artifactId: 'rapor',
        parts: [{ url: 'https://agent.example/d/1', mediaType: 'text/plain' }],
      });
      await h.chain.setStatus(JOB_A, 'delivered');
      await context.complete('teslim edildi');
    });
    const { task } = await h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(task?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task?.status.message?.parts).toEqual([{ text: 'teslim edildi' }]);
    expect(task?.artifacts?.map((a) => a.artifactId)).toEqual(['rapor']);
    expect(task?.history?.map((m) => m.role)).toEqual(['ROLE_USER', 'ROLE_AGENT', 'ROLE_AGENT']);
    expect(task?.metadata?.square).toMatchObject({ jobStatus: 'delivered' });
  });

  it("zincirle tutarsız geçiş agent'a hata verir", async () => {
    await h.openJob(JOB_A, 'a');
    let caught: unknown;
    h.scripts.set(JOB_A, async (context) => {
      try {
        await context.complete('job teslim edilmeden');
      } catch (error) {
        caught = error;
      }
      await context.reject('kabul etmiyorum');
    });
    const { task } = await h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(String(caught)).toMatch(/tutarsız/);
    expect(task?.status.state).toBe('TASK_STATE_REJECTED');
  });

  it('agent hata fırlatırsa görev FAILED olur', async () => {
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async () => {
      throw new Error('agent çöktü');
    });
    const { task } = await h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(task?.status.state).toBe('TASK_STATE_FAILED');
    expect(h.errors).toHaveLength(1);
  });

  it('GetTask zincirle uzlaşır: kabul WORKING, iptal CANCELED; terminal görev settlement ile değişmez', async () => {
    await h.openJob(JOB_A, 'a');
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    await h.chain.setStatus(JOB_A, 'accepted');
    expect((await client.getTask({ id: task!.id })).status.state).toBe('TASK_STATE_WORKING');
    await h.chain.setStatus(JOB_A, 'delivered');
    expect((await client.getTask({ id: task!.id })).status.state).toBe('TASK_STATE_COMPLETED');
    await h.chain.setStatus(JOB_A, 'refunded');
    const settled = await client.getTask({ id: task!.id });
    expect(settled.status.state).toBe('TASK_STATE_COMPLETED');
    expect(settled.metadata?.square).toMatchObject({ jobStatus: 'refunded' });
  });

  it('bloklayan SendMessage süre dolunca güncel görevi döner', async () => {
    await h.stop();
    h = new Harness(db, { ...LIMITS, blockingTimeoutMs: 200 });
    await h.start();
    await h.openJob(JOB_A, 'a');
    const { task } = await h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(task?.status.state).toBe('TASK_STATE_SUBMITTED');
  });

  it('kesintideki görev ek mesajla devam eder', async () => {
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('teslim tarihi nedir?'));
    h.continuations.set(JOB_A, async (context, message) => {
      expect(message.parts).toEqual([{ text: 'cuma' }]);
      await context.reject('tarih uygun değil');
    });
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    await client.sendMessage({
      message: { messageId: 'm-2', role: 'ROLE_USER', taskId: task!.id, parts: [{ text: 'cuma' }] },
      configuration: { returnImmediately: true },
    });
    await until(async () => (await client.getTask({ id: task!.id })).status.state === 'TASK_STATE_REJECTED');
    await expect(
      client.sendMessage({
        message: { messageId: 'm-3', role: 'ROLE_USER', taskId: task!.id, parts: [{ text: 'tekrar' }] },
      }),
    ).rejects.toSatisfy((e) => (e as A2aError).code === -32004);
    await expect(
      client.sendMessage({ message: { messageId: 'm-4', role: 'ROLE_USER', taskId: 'yok', parts: [{ text: 'x' }] } }),
    ).rejects.toMatchObject({ code: -32001 });
  });
});

describe('iptal', () => {
  it('kabulden önce iptal edilir, agent sinyali kesilir; tekrar iptal aynı görevi döner', async () => {
    await h.openJob(JOB_A, 'a');
    let aborted = false;
    h.scripts.set(JOB_A, async (context) => {
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()));
      aborted = true;
    });
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    const canceled = await client.cancelTask({ id: task!.id });
    expect(canceled.status.state).toBe('TASK_STATE_CANCELED');
    await until(() => aborted);
    expect((await client.cancelTask({ id: task!.id })).status.state).toBe('TASK_STATE_CANCELED');
  });

  it('job kabul edildiyse iptal edilemez (-32002); terminal görev de', async () => {
    await h.openJob(JOB_A, 'a');
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    await h.chain.setStatus(JOB_A, 'accepted');
    await expect(client.cancelTask({ id: task!.id })).rejects.toMatchObject({ code: -32002 });
    await h.chain.setStatus(JOB_A, 'delivered');
    await client.getTask({ id: task!.id });
    await expect(client.cancelTask({ id: task!.id })).rejects.toMatchObject({ code: -32002 });
  });
});

describe('listeleme', () => {
  it('çağırana kapsamlı, sayfalı; artefaktlar istenmedikçe yok', async () => {
    for (const [job, title] of [
      [JOB_A, 'a'],
      [JOB_B, 'b'],
      [JOB_C, 'c'],
    ] as const) {
      await h.openJob(job, title);
      await h.client().sendMessage({ message: openingMessage(job, title), configuration: { returnImmediately: true } });
    }
    const client = h.client();
    const page1 = await client.listTasks({ pageSize: 2 });
    expect(page1).toMatchObject({ pageSize: 2, totalSize: 3 });
    expect(page1.tasks).toHaveLength(2);
    expect(page1.tasks[0]?.artifacts).toBeUndefined();
    const page2 = await client.listTasks({ pageSize: 2, pageToken: page1.nextPageToken });
    expect(page2.tasks).toHaveLength(1);
    expect(page2.nextPageToken).toBe('');
    expect((await client.listTasks({ includeArtifacts: true })).tasks[0]?.artifacts).toEqual([]);
    expect((await client.listTasks({ contextId: JOB_B })).tasks.map((t) => t.contextId)).toEqual([JOB_B]);
    await expect(client.listTasks({ pageToken: 'bozuk' })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('akış', () => {
  it('SendStreamingMessage: önce görev, sonra durum ve artefakt olayları; terminalde kapanır', async () => {
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => {
      await h.chain.setStatus(JOB_A, 'accepted');
      await context.working();
      await context.addArtifact({ artifactId: 'rapor', parts: [{ text: 'bölüm 1' }] }, { lastChunk: false });
      await context.addArtifact(
        { artifactId: 'rapor', parts: [{ text: 'bölüm 2' }] },
        { append: true, lastChunk: true },
      );
      await h.chain.setStatus(JOB_A, 'delivered');
      await context.complete();
    });
    const events: StreamResponse[] = [];
    for await (const event of h.client().sendStreamingMessage({ message: openingMessage(JOB_A, 'a') }))
      events.push(event);
    expect(Object.keys(events[0]!)).toEqual(['task']);
    const states = events.flatMap((e) => (e.statusUpdate ? [e.statusUpdate.status.state] : []));
    expect(states).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED']);
    const chunks = events.flatMap((e) => (e.artifactUpdate ? [e.artifactUpdate] : []));
    expect(chunks.map((c) => [c.append ?? false, c.lastChunk ?? false])).toEqual([
      [false, false],
      [true, true],
    ]);
    const task = await h.client().getTask({ id: events[0]!.task!.id });
    expect(task.artifacts?.[0]?.parts).toEqual([{ text: 'bölüm 1' }, { text: 'bölüm 2' }]);
  });

  it('SubscribeToTask yeniden bağlanır; terminal görevde -32004', async () => {
    await h.openJob(JOB_A, 'a');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.scripts.set(JOB_A, async (context) => {
      await gate;
      await context.reject('vazgeçtim');
    });
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    const seen: StreamResponse[] = [];
    const reading = (async () => {
      for await (const event of client.subscribeToTask({ id: task!.id })) seen.push(event);
    })();
    await until(() => seen.length === 1);
    release();
    await reading;
    expect(seen.at(-1)?.statusUpdate?.status.state).toBe('TASK_STATE_REJECTED');
    await expect(
      (async () => {
        for await (const event of client.subscribeToTask({ id: task!.id })) void event;
      })(),
    ).rejects.toMatchObject({ code: -32004 });
  });

  it('çağıran başına akış sınırı aşılınca 429', async () => {
    const client = h.client();
    const open: AsyncIterator<StreamResponse>[] = [];
    for (const [job, title] of [
      [JOB_A, 'a'],
      [JOB_B, 'b'],
    ] as const) {
      await h.openJob(job, title);
      const { task } = await client.sendMessage({
        message: openingMessage(job, title),
        configuration: { returnImmediately: true },
      });
      const iterator = client.subscribeToTask({ id: task!.id })[Symbol.asyncIterator]();
      await iterator.next();
      open.push(iterator);
    }
    await h.openJob(JOB_C, 'c');
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_C, 'c'),
      configuration: { returnImmediately: true },
    });
    await expect(
      (async () => {
        for await (const event of client.subscribeToTask({ id: task!.id })) void event;
      })(),
    ).rejects.toMatchObject({ code: -32000 });
    await h.openJob(JOB_D, 'd');
    await expect(
      (async () => {
        for await (const event of client.sendStreamingMessage({ message: openingMessage(JOB_D, 'd') })) void event;
      })(),
    ).rejects.toMatchObject({ code: -32000 });
    expect((await client.listTasks({})).tasks.map((t) => t.metadata?.square)).not.toContainEqual(
      expect.objectContaining({ job: JOB_D }),
    );
    expect((await h.client(KEY_B).listTasks({})).tasks).toEqual([]);
    await Promise.all(open.map((iterator) => iterator.return?.()));
  });
});
