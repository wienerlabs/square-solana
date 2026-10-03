import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import type { StreamResponse } from '@squaresdk/solana-types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { A2aError, ERROR_INFO_TYPE } from '../src/errors.js';
import { createTaskEventBus } from '../src/events.js';
import type { TaskContext } from '../src/server.js';
import { TaskStoreError, type TaskStore } from '../src/store.js';
import { AGENT_RECORD, FOREIGN_PROGRAM, JOB_A, JOB_B, JOB_C, JOB_D, OTHER_AGENT_RECORD } from './helpers/fixtures.js';
import {
  callerOf,
  Harness,
  KEY_A,
  KEY_A2,
  KEY_B,
  LIMITS,
  openingMessage,
  spec,
  specHashOf,
  until,
  type HarnessOptions,
} from './helpers/harness.js';

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

async function restart(options: HarnessOptions) {
  await h.stop();
  h = new Harness(db, options);
  await h.start();
}

const versionOf = async (id: string) => (await db.client.a2aTask.findUniqueOrThrow({ where: { id } })).version;

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

  it('kimlik yoksa 401; kimlik gövde okunmadan denetlenir', async () => {
    const { status, json } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
      { 'x-api-key': '' },
    );
    expect(status).toBe(401);
    expect(json.error?.code).toBe(-32000);
    expect((await rpc('{', { 'x-api-key': 'gecersiz-anahtar' })).status).toBe(401);
  });

  it('kapanan sunucu yeni isteği 503 ile reddeder', async () => {
    await h.server.close();
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } });
    expect(status).toBe(503);
    expect(json.error?.code).toBe(-32000);
  });

  it('sürüm başlığındaki biçimsiz değer hata ayrıntısına yansımaz', async () => {
    const { json } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
      { 'a2a-version': '<script>' },
    );
    expect(json.error?.code).toBe(-32009);
    expect(JSON.stringify(json)).not.toContain('script');
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

  it('I-JSON dışı değerler (NUL, eşleşmemiş surrogate, sonlu olmayan sayı, aşırı derinlik) -32602; iç hata yok', async () => {
    await h.openJob(JOB_A, 'a');
    const base = openingMessage(JOB_A, 'a');
    const client = h.client();
    await expect(client.sendMessage({ message: { ...base, parts: [{ text: 'a\u0000b' }] } })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(client.sendMessage({ message: { ...base, messageId: 'm\u0000' } })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      client.sendMessage({ message: { ...base, parts: [{ data: { x: '\ud800' } }] } }),
    ).rejects.toMatchObject({ code: -32602 });
    const infinite = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: base },
    }).replace('"metadata":{', '"metadata":{"n":1e999,');
    expect((await rpc(infinite)).json.error?.code).toBe(-32602);
    type Nested = string | Nested[];
    let deep: Nested = 'dip';
    for (let i = 0; i < 100; i += 1) deep = [deep];
    await expect(client.sendMessage({ message: { ...base, parts: [{ data: deep }] } })).rejects.toMatchObject({
      code: -32602,
    });
    const token = Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: 'uuid-değil' })).toString('base64url');
    await expect(client.listTasks({ pageToken: token })).rejects.toMatchObject({ code: -32602 });
    await expect(client.listTasks({ statusTimestampAfter: '0000-01-01T00:00:00Z' })).rejects.toMatchObject({
      code: -32602,
    });
    const ancient = Buffer.from(
      JSON.stringify({ t: '0000-01-01T00:00:00.000Z', i: '00000000-0000-4000-8000-000000000000' }),
    ).toString('base64url');
    await expect(client.listTasks({ pageToken: ancient })).rejects.toMatchObject({ code: -32602 });
    expect(h.errors).toEqual([]);
  });
});

describe('görev açma', () => {
  it('returnImmediately ile SUBMITTED görev; GetTask ve meta veri', async () => {
    await h.openJob(JOB_A, 'a');
    const { task } = await h
      .client()
      .sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    expect(task).toMatchObject({ contextId: JOB_A, status: { state: 'TASK_STATE_SUBMITTED' } });
    expect(task?.metadata?.square).toMatchObject({ job: JOB_A, jobStatus: 'funded', slot: expect.any(Number) });
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

  it('aynı mesajın tekrarı job kabul edildikten sonra da aynı görevi döner', async () => {
    await h.openJob(JOB_A, 'a');
    const client = h.client();
    const first = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    await h.chain.setStatus(JOB_A, 'accepted');
    const again = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    expect(again.task?.id).toBe(first.task?.id);
    expect(again.task?.status.state).toBe('TASK_STATE_WORKING');
    const conflicting = { ...openingMessage(JOB_A, 'a'), parts: [{ text: 'başka içerik' }] };
    await expect(
      client.sendMessage({ message: conflicting, configuration: { returnImmediately: true } }),
    ).rejects.toSatisfy((e) => reason(e) === 'MESSAGE_ID_CONFLICT');
  });

  it("job'un etkin görevi varken aynı kurumun başka anahtarı ikinci görev açamaz", async () => {
    await h.openJob(JOB_A, 'a');
    await h.client().sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    await expect(
      h
        .client(KEY_A2)
        .sendMessage({ message: openingMessage(JOB_A, 'a', 'm-a2'), configuration: { returnImmediately: true } }),
    ).rejects.toSatisfy((e) => reason(e) === 'JOB_HAS_ACTIVE_TASK');
  });

  it("job'un kurumuna bağlı olmayan çağıran görev açamaz ve etkin görevin varlığını öğrenemez", async () => {
    await h.openJob(JOB_A, 'a');
    const stranger = h.client(KEY_B);
    const attempt = () =>
      stranger.sendMessage({ message: openingMessage(JOB_A, 'a', 'm-b'), configuration: { returnImmediately: true } });
    await expect(attempt()).rejects.toSatisfy((e) => reason(e) === 'JOB_NOT_FOR_CALLER');
    await h.client().sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    await expect(attempt()).rejects.toSatisfy((e) => reason(e) === 'JOB_NOT_FOR_CALLER');
  });

  it('escrow programına ait olmayan sahte job hesabıyla görev açılmaz', async () => {
    await h.chain.setJob(JOB_A, {
      status: 'funded',
      agentRecord: AGENT_RECORD,
      specHash: specHashOf(spec('a')),
      owner: FOREIGN_PROGRAM,
    });
    await expect(
      h.client().sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } }),
    ).rejects.toSatisfy((e) => reason(e) === 'JOB_NOT_FOUND');
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
    for (const key of [KEY_B, KEY_A2]) {
      await expect(h.client(key).getTask({ id: task!.id })).rejects.toMatchObject({ code: -32001 });
      await expect(h.client(key).cancelTask({ id: task!.id })).rejects.toMatchObject({ code: -32001 });
      expect((await h.client(key).listTasks({})).tasks).toEqual([]);
    }
  });
});

describe('agent akışı ve zincir', () => {
  it('bloklayan SendMessage görev bitince döner; artefakt ve geçmiş', async () => {
    await h.openJob(JOB_A, 'a');
    let caller = '';
    h.scripts.set(JOB_A, async (context) => {
      caller = context.caller;
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
    expect(caller).toBe(callerOf(KEY_A));
  });

  it('okumalar görevi yazmaz; slot yanıtta günceldir', async () => {
    await h.openJob(JOB_A, 'a');
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    const slots: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      slots.push(((await client.getTask({ id: task!.id })).metadata?.square as { slot: number }).slot);
    }
    expect(new Set(slots).size).toBe(4);
    expect(await versionOf(task!.id)).toBe(0);
  });

  it('okumalarla yarışan eşzamanlı agent yazmaları kaybolmaz', async () => {
    await h.openJob(JOB_A, 'a');
    let failure: unknown = null;
    h.scripts.set(JOB_A, async (context) => {
      await h.chain.setStatus(JOB_A, 'accepted');
      await context.working();
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          context.addArtifact({ artifactId: `p-${i}`, parts: [{ text: `parça ${i}` }] }),
        ),
      ).catch((error: unknown) => (failure = error));
      await h.chain.setStatus(JOB_A, 'delivered');
      await context.complete();
    });
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    const polling = (async () => {
      for (let i = 0; i < 20; i += 1) await client.getTask({ id: task!.id });
    })();
    await until(async () => (await client.getTask({ id: task!.id })).status.state === 'TASK_STATE_COMPLETED');
    await polling;
    expect(failure).toBeNull();
    expect((await client.getTask({ id: task!.id })).artifacts).toHaveLength(8);
  });

  it("zincir görevi önce tamamlarsa agent'ın complete çağrısı hata vermez, metni geçmişe eklenir", async () => {
    await h.openJob(JOB_A, 'a');
    let delivered!: () => void;
    let proceed!: () => void;
    const deliveredP = new Promise<void>((resolve) => (delivered = resolve));
    const proceedP = new Promise<void>((resolve) => (proceed = resolve));
    let outcome: unknown = 'bekliyor';
    h.scripts.set(JOB_A, async (context) => {
      await h.chain.setStatus(JOB_A, 'accepted');
      await context.working();
      await h.chain.setStatus(JOB_A, 'delivered');
      delivered();
      await proceedP;
      outcome = await context.complete('teslim edildi').then(
        () => null,
        (error: unknown) => error,
      );
    });
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    await deliveredP;
    expect((await client.getTask({ id: task!.id })).status.state).toBe('TASK_STATE_COMPLETED');
    proceed();
    await until(() => outcome !== 'bekliyor');
    expect(outcome).toBeNull();
    const final = await client.getTask({ id: task!.id });
    expect(final.status.state).toBe('TASK_STATE_COMPLETED');
    expect(final.history?.at(-1)?.parts).toEqual([{ text: 'teslim edildi' }]);
  });

  it("artefakt boyut sınırını aşan ekleme agent'a hata verir, görev değişmez", async () => {
    await restart({ limits: { maxArtifactBytes: 1024 } });
    await h.openJob(JOB_A, 'a');
    let caught: unknown;
    h.scripts.set(JOB_A, async (context) => {
      await context.addArtifact({ artifactId: 'küçük', parts: [{ text: 'tamam' }] });
      await context.addArtifact({ artifactId: 'büyük', parts: [{ text: 'x'.repeat(2048) }] }).catch((e: unknown) => {
        caught = e;
      });
      await context.reject('sınır');
    });
    const { task } = await h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(String(caught)).toMatch(/1024/);
    expect(task?.artifacts?.map((a) => a.artifactId)).toEqual(['küçük']);
  });

  it("zincir okunamazsa GetTask kayıttaki görevi döner, iptal iç hata verir; hata onError'a gider", async () => {
    let failing = false;
    await restart({
      wrapJobSource: (source) => ({
        getJob: async (address) => {
          if (failing) throw new Error('rpc düştü');
          return source.getJob(address);
        },
      }),
    });
    await h.openJob(JOB_A, 'a');
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    failing = true;
    expect((await client.getTask({ id: task!.id })).status.state).toBe('TASK_STATE_SUBMITTED');
    await expect(client.cancelTask({ id: task!.id })).rejects.toMatchObject({ code: -32603 });
    expect(h.errors.map(String)).toEqual(['Error: rpc düştü', 'Error: rpc düştü']);
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
    await restart({ limits: { blockingTimeoutMs: 200 } });
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

  it('bloklayan devam mesajı agent yanıt verene kadar bekler; agent mesajları sırayla işler', async () => {
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('teslim tarihi nedir?'));
    let active = 0;
    let overlap = false;
    let handled = 0;
    h.continuations.set(JOB_A, async (context, message) => {
      active += 1;
      if (active > 1) overlap = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      active -= 1;
      if (message.messageId === 'm-son') await context.reject('tarih uygun değil');
      else await context.requireInput('başka bir tarih?');
      handled += 1;
    });
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const reply = (messageId: string, text: string) =>
      client.sendMessage({ message: { messageId, role: 'ROLE_USER', taskId: task!.id, parts: [{ text }] } });
    const [first, second] = await Promise.all([reply('m-2', 'cuma'), reply('m-3', 'cumartesi')]);
    expect(first.task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(second.task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    await until(() => handled === 2);
    expect(overlap).toBe(false);
    const last = await reply('m-son', 'pazar');
    expect(last.task?.status.state).toBe('TASK_STATE_REJECTED');
    const again = await client.sendMessage({
      message: { messageId: 'm-2', role: 'ROLE_USER', taskId: task!.id, parts: [{ text: 'cuma' }] },
    });
    expect(again.task?.status.state).toBe('TASK_STATE_REJECTED');
  });

  it('devam mesajı: bağlam uyuşmazlığı, mesaj sınırı ve zincirde iptal edilmiş görev', async () => {
    await restart({ limits: { maxMessagesPerTask: 3 } });
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('ayrıntı?'));
    let calls = 0;
    h.continuations.set(JOB_A, async (context) => {
      calls += 1;
      await context.requireInput('başka ayrıntı?');
    });
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    const reply = (messageId: string, extra: Record<string, unknown> = {}) =>
      client.sendMessage({
        message: { messageId, role: 'ROLE_USER', taskId: task!.id, parts: [{ text: messageId }], ...extra },
      });
    await expect(reply('m-x', { contextId: 'başka' })).rejects.toSatisfy((e) => reason(e) === 'CONTEXT_ID_MISMATCH');
    await reply('m-2');
    await expect(reply('m-2', { parts: [{ text: 'başka içerik' }] })).rejects.toSatisfy(
      (e) => reason(e) === 'MESSAGE_ID_CONFLICT',
    );
    await expect(reply('m-3')).rejects.toSatisfy(
      (e) => (e as A2aError).code === -32004 && reason(e) === 'TASK_MESSAGE_LIMIT',
    );
    await h.chain.setStatus(JOB_A, 'cancelled');
    await expect(reply('m-4')).rejects.toSatisfy((e) => reason(e) === 'TASK_TERMINAL');
    expect((await client.getTask({ id: task!.id })).status.state).toBe('TASK_STATE_CANCELED');
    expect(calls).toBe(1);
  });

  it('devam mesajı desteklemeyen agent -32004 döner', async () => {
    await restart({ continuations: false });
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('ayrıntı?'));
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    await expect(
      client.sendMessage({
        message: { messageId: 'm-2', role: 'ROLE_USER', taskId: task!.id, parts: [{ text: 'x' }] },
      }),
    ).rejects.toSatisfy((e) => reason(e) === 'CONTINUATION_NOT_SUPPORTED');
  });

  it('istemci ayrılınca bloklayan SendMessage beklemeyi bırakır', async () => {
    const bus = createTaskEventBus();
    let subscriptions = 0;
    await restart({
      limits: { blockingTimeoutMs: 30_000 },
      bus: {
        publish: bus.publish,
        subscribe: (taskId, listener) => {
          subscriptions += 1;
          const unsubscribe = bus.subscribe(taskId, listener);
          return () => {
            subscriptions -= 1;
            unsubscribe();
          };
        },
      },
    });
    await h.openJob(JOB_A, 'a');
    const controller = new AbortController();
    const pending = fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', 'x-api-key': KEY_A },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: { message: openingMessage(JOB_A, 'a') },
      }),
      signal: controller.signal,
    }).catch(() => null);
    await until(() => subscriptions === 1);
    controller.abort();
    await pending;
    await until(() => subscriptions === 0);
  });
});

describe('devam mesajlarının teslimi', () => {
  it('kapanışta yarım kalan devam mesajı yeniden başlatmada resume ile yeniden iletilir', async () => {
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('teslim tarihi?'));
    let started = false;
    h.continuations.set(JOB_A, async (context) => {
      started = true;
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    await client.sendMessage({
      message: { messageId: 'm-2', role: 'ROLE_USER', taskId: task!.id, parts: [{ text: 'cuma' }] },
      configuration: { returnImmediately: true },
    });
    await until(() => started);
    await restart({ chain: h.chain });
    const delivered: string[] = [];
    h.continuations.set(JOB_A, async (context, message) => {
      delivered.push(`${context.message.messageId}:${message.messageId}`);
      await context.reject('tarih uygun değil');
    });
    expect(await h.server.resume()).toBe(1);
    await until(() => delivered.length === 1);
    expect(delivered).toEqual(['m-a:m-2']);
    await until(async () => (await h.client().getTask({ id: task!.id })).status.state === 'TASK_STATE_REJECTED');
    expect(await h.server.resume()).toBe(0);
  });

  it('kaydedildikten sonra iletilemeyen devam mesajı aynı kimlikle tekrarda iletilir', async () => {
    let failOpening = false;
    await restart({
      wrapStore: (store): TaskStore => ({
        ...store,
        message: async (taskId, messageId) => {
          if (failOpening && messageId === 'm-a') {
            failOpening = false;
            throw new Error('geçici depo hatası');
          }
          return store.message(taskId, messageId);
        },
      }),
    });
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('teslim tarihi?'));
    const delivered: string[] = [];
    h.continuations.set(JOB_A, async (context, message) => {
      delivered.push(message.messageId);
      await context.reject('tarih uygun değil');
    });
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    const reply = () =>
      client.sendMessage({
        message: { messageId: 'm-2', role: 'ROLE_USER', taskId: task!.id, parts: [{ text: 'cuma' }] },
      });
    failOpening = true;
    await expect(reply()).rejects.toMatchObject({ code: -32603 });
    expect(delivered).toEqual([]);
    expect((await reply()).task?.status.state).toBe('TASK_STATE_REJECTED');
    expect(delivered).toEqual(['m-2']);
  });

  it('resume bu süreçte çalışan görevi ikinci kez başlatmaz', async () => {
    await h.openJob(JOB_A, 'a');
    let calls = 0;
    h.scripts.set(JOB_A, async (context) => {
      calls += 1;
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await h.client().sendMessage({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } });
    await until(() => calls === 1);
    expect(await h.server.resume()).toBe(0);
    expect(calls).toBe(1);
  });

  it('kapanış bekleyen SendMessage isteğini bırakır', async () => {
    await restart({ limits: { blockingTimeoutMs: 30_000 } });
    await h.openJob(JOB_A, 'a');
    const pending = h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    await until(async () => (await db.client.a2aTask.count()) === 1);
    const closedAt = Date.now();
    await h.server.close();
    const { task } = await pending;
    expect(task?.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(Date.now() - closedAt).toBeLessThan(5_000);
  });
});

describe('agent girdisi ve akış açılışı', () => {
  it("agent'ın NUL içeren metni ve artefaktı depoya gitmeden reddedilir", async () => {
    await h.openJob(JOB_A, 'a');
    const failures: string[] = [];
    h.scripts.set(JOB_A, async (context) => {
      await context.requireInput('a\u0000b').catch((e: unknown) => failures.push(String(e)));
      await context
        .addArtifact({ artifactId: 'x', parts: [{ text: 'c\u0000d' }] })
        .catch((e: unknown) => failures.push(String(e)));
      await context.reject('geçersiz metin');
    });
    const { task } = await h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(task?.status.state).toBe('TASK_STATE_REJECTED');
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.includes('I-JSON'))).toBe(true);
    expect(task?.artifacts).toBeUndefined();
  });

  it('akışın ilk karesi hazırlanamazsa SSE açılmadan hata döner', async () => {
    let failHistory = false;
    await restart({
      wrapStore: (store): TaskStore => ({
        ...store,
        history: async (taskId, limit) => {
          if (failHistory) {
            failHistory = false;
            throw new Error('geçmiş okunamadı');
          }
          return store.history(taskId, limit);
        },
      }),
    });
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('?'));
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    failHistory = true;
    await expect(
      (async () => {
        for await (const event of client.subscribeToTask({ id: task!.id })) void event;
      })(),
    ).rejects.toMatchObject({ code: -32603 });
  });

  it('akış açılmadan ayrılan istemcinin akış yeri bırakılır', async () => {
    let gate: Promise<void> | null = null;
    let reached: () => void = () => undefined;
    await restart({
      limits: { maxStreamsPerCaller: 1 },
      wrapStore: (store): TaskStore => ({
        ...store,
        history: async (taskId, limit) => {
          if (gate) {
            const waiting = gate;
            gate = null;
            reached();
            await waiting;
          }
          return store.history(taskId, limit);
        },
      }),
    });
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('?'));
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    let open: () => void = () => undefined;
    gate = new Promise<void>((resolve) => (open = resolve));
    const reachedP = new Promise<void>((resolve) => (reached = resolve));
    const first = new AbortController();
    const firstStream = (async () => {
      for await (const event of client.subscribeToTask({ id: task!.id }, { signal: first.signal })) void event;
    })().catch(() => null);
    await reachedP;
    first.abort();
    await firstStream;
    await new Promise((resolve) => setTimeout(resolve, 50));
    open();
    await until(async () => {
      const second = new AbortController();
      let received = 0;
      await (async () => {
        for await (const event of client.subscribeToTask({ id: task!.id }, { signal: second.signal })) {
          void event;
          received += 1;
          second.abort();
        }
      })().catch(() => null);
      return received === 1;
    }, 3_000);
  });

  it('akışın anlık görüntüsünden önce yayımlanan olay tekrar gönderilmez', async () => {
    let hook: { remaining: number; run: () => Promise<void> } | null = null;
    let fired = false;
    await restart({
      wrapStore: (store): TaskStore => ({
        ...store,
        get: async (agentRecord, id) => {
          if (hook) {
            hook.remaining -= 1;
            if (hook.remaining === 0) {
              const { run } = hook;
              hook = null;
              fired = true;
              await run();
            }
          }
          return store.get(agentRecord, id);
        },
      }),
    });
    await h.openJob(JOB_A, 'a');
    let captured: TaskContext | null = null;
    h.scripts.set(JOB_A, async (context) => {
      captured = context;
      await context.requireInput('?');
    });
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    await h.chain.setStatus(JOB_A, 'accepted');
    hook = { remaining: 3, run: () => captured!.working('başladı') };
    const controller = new AbortController();
    const states: string[] = [];
    await (async () => {
      for await (const event of client.subscribeToTask({ id: task!.id }, { signal: controller.signal })) {
        states.push(event.task?.status.state ?? event.statusUpdate?.status.state ?? 'yok');
        setTimeout(() => controller.abort(), 300);
      }
    })().catch(() => null);
    expect(fired).toBe(true);
    expect(states).toEqual(['TASK_STATE_WORKING']);
  });
});

describe('yeniden başlatma', () => {
  it("resume SUBMITTED ve WORKING görevleri agent'a yeniden verir; bekleyen ve terminal görevler verilmez", async () => {
    for (const [job, title] of [
      [JOB_A, 'a'],
      [JOB_B, 'b'],
      [JOB_C, 'c'],
      [JOB_D, 'd'],
    ] as const) {
      await h.openJob(job, title);
    }
    const hang = (context: { signal: AbortSignal }) =>
      new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    h.scripts.set(JOB_A, hang);
    h.scripts.set(JOB_B, async (context) => context.requireInput('ayrıntı?'));
    h.scripts.set(JOB_C, async (context) => {
      await h.chain.setStatus(JOB_C, 'accepted');
      await context.working();
      await hang(context);
    });
    h.scripts.set(JOB_D, async (context) => context.reject('hayır'));
    const client = h.client();
    const ids: Record<string, string> = {};
    for (const [job, title] of [
      [JOB_A, 'a'],
      [JOB_B, 'b'],
      [JOB_C, 'c'],
      [JOB_D, 'd'],
    ] as const) {
      const { task } = await client.sendMessage({
        message: openingMessage(job, title),
        configuration: { returnImmediately: true },
      });
      ids[job] = task!.id;
    }
    await until(async () => (await client.getTask({ id: ids[JOB_C]! })).status.state === 'TASK_STATE_WORKING');
    await until(async () => (await client.getTask({ id: ids[JOB_D]! })).status.state === 'TASK_STATE_REJECTED');
    await until(async () => (await client.getTask({ id: ids[JOB_B]! })).status.state === 'TASK_STATE_INPUT_REQUIRED');

    const chain = h.chain;
    await restart({ chain });
    const resumed: string[] = [];
    h.scripts.set(JOB_A, async (context) => {
      resumed.push(context.message.messageId);
      await context.reject('yeniden başladı');
    });
    h.scripts.set(JOB_C, async (context) => {
      resumed.push(context.message.messageId);
      await h.chain.setStatus(JOB_C, 'delivered');
      await context.complete('tamamlandı');
    });
    expect(await h.server.resume()).toBe(2);
    await until(() => resumed.length === 2);
    expect(resumed.sort()).toEqual(['m-a', 'm-c']);
    const fresh = h.client();
    await until(async () => (await fresh.getTask({ id: ids[JOB_C]! })).status.state === 'TASK_STATE_COMPLETED');
    expect((await fresh.getTask({ id: ids[JOB_A]! })).status.state).toBe('TASK_STATE_REJECTED');
    expect((await fresh.getTask({ id: ids[JOB_B]! })).status.state).toBe('TASK_STATE_INPUT_REQUIRED');
  });
});

describe('eşzamanlılık', () => {
  it('başka bir yazıcıyla sürüm çakışmasında geçiş ve iptal yeniden dener', async () => {
    let conflicts = 2;
    await restart({
      wrapStore: (store): TaskStore => ({
        ...store,
        update: async (...args: Parameters<TaskStore['update']>) => {
          if (conflicts > 0) {
            conflicts -= 1;
            throw new TaskStoreError('version', 'başka bir örnek yazdı');
          }
          return store.update(...args);
        },
      }),
    });
    await h.openJob(JOB_A, 'a');
    h.scripts.set(JOB_A, async (context) => context.requireInput('ayrıntı?'));
    const client = h.client();
    const { task } = await client.sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(task?.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    conflicts = 1;
    expect((await client.cancelTask({ id: task!.id })).status.state).toBe('TASK_STATE_CANCELED');
    expect(conflicts).toBe(0);
  });
});

describe('sürüm çakışması', () => {
  const conflicting =
    (counter: { value: number }) =>
    (store: TaskStore): TaskStore => ({
      ...store,
      update: async (...args: Parameters<TaskStore['update']>) => {
        if (counter.value > 0) {
          counter.value -= 1;
          throw new TaskStoreError('version', 'başka bir örnek yazdı');
        }
        return store.update(...args);
      },
    });

  it('uzlaştırma çakışmada kayıttaki görevi döner, sonraki okuma ilerletir', async () => {
    const conflicts = { value: 0 };
    await restart({ wrapStore: conflicting(conflicts) });
    await h.openJob(JOB_A, 'a');
    const client = h.client();
    const { task } = await client.sendMessage({
      message: openingMessage(JOB_A, 'a'),
      configuration: { returnImmediately: true },
    });
    await h.chain.setStatus(JOB_A, 'accepted');
    conflicts.value = 1;
    expect((await client.getTask({ id: task!.id })).status.state).toBe('TASK_STATE_SUBMITTED');
    expect((await client.getTask({ id: task!.id })).status.state).toBe('TASK_STATE_WORKING');
  });

  it("sürekli çakışmada artefakt eklemesi agent'a hata verir", async () => {
    const conflicts = { value: 0 };
    await restart({ wrapStore: conflicting(conflicts) });
    await h.openJob(JOB_A, 'a');
    let failure: unknown = null;
    h.scripts.set(JOB_A, async (context) => {
      conflicts.value = 10;
      failure = await context.addArtifact({ artifactId: 'x', parts: [{ text: 'y' }] }).then(
        () => null,
        (error: unknown) => error,
      );
      conflicts.value = 0;
      await context.reject('bitti');
    });
    const { task } = await h.client().sendMessage({ message: openingMessage(JOB_A, 'a') });
    expect(String(failure)).toMatch(/eşzamanlı/);
    expect(task?.status.state).toBe('TASK_STATE_REJECTED');
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
