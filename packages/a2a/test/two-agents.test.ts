// İki agent arasında görev akışı (BE-17 kabul kriteri): kurumun agent'ı (istemci) işi A2A ile
// isteyen taraf, işi yapan agent (sunucu) görevi zincirdeki job'a göre ilerletir. Akış SSE ile izlenir,
// görev ve geçmişi sunucu yeniden başladıktan sonra da depodan okunur.
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import type { StreamResponse } from '@squaresdk/solana-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_RECORD, JOB_A, JOB_B } from './helpers/fixtures.js';
import { Harness, openingMessage, spec, specHashOf, until } from './helpers/harness.js';

let db: IsolatedDatabase;

beforeAll(async () => {
  db = await startIsolatedDatabase();
});

afterAll(async () => {
  await db?.stop();
});

describe('iki agent arasında görev', () => {
  it("kurum agent'ı işi ister; işi yapan agent kabul eder, artefaktı teslim eder; görev kalıcıdır", async () => {
    const worker = new Harness(db);
    await worker.start();
    await worker.openJob(JOB_A, 'pazar-araştırması');
    worker.scripts.set(JOB_A, async (context) => {
      expect(context.message.parts[0]?.data).toEqual({ title: 'pazar-araştırması', deliverable: 'rapor' });
      await worker.chain.setStatus(JOB_A, 'accepted');
      await context.working('job zincirde kabul edildi');
      await context.addArtifact({
        artifactId: 'rapor',
        name: 'Pazar araştırması raporu',
        parts: [{ url: 'https://agent.example/deliveries/rapor', mediaType: 'application/pdf' }],
        metadata: { square: { workHash: 'cd'.repeat(32) } },
      });
      await worker.chain.setStatus(JOB_A, 'delivered');
      await context.complete('teslim edildi; challenge penceresi açık');
    });

    const institution = worker.client();
    const events: StreamResponse[] = [];
    for await (const event of institution.sendStreamingMessage({
      message: openingMessage(JOB_A, 'pazar-araştırması'),
    })) {
      events.push(event);
    }
    const taskId = events[0]!.task!.id;
    expect(events[0]!.task!.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(events.flatMap((e) => (e.statusUpdate ? [e.statusUpdate.status.state] : []))).toEqual([
      'TASK_STATE_WORKING',
      'TASK_STATE_COMPLETED',
    ]);
    expect(events.find((e) => e.artifactUpdate)?.artifactUpdate?.artifact.artifactId).toBe('rapor');

    await worker.stop();
    const restarted = new Harness(db);
    await restarted.start();
    await restarted.chain.setJob(JOB_A, {
      status: 'released',
      agentRecord: AGENT_RECORD,
      specHash: specHashOf(spec('pazar-araştırması')),
    });
    const persisted = await restarted.client().getTask({ id: taskId });
    expect(persisted.status.state).toBe('TASK_STATE_COMPLETED');
    expect(persisted.status.message?.parts).toEqual([{ text: 'teslim edildi; challenge penceresi açık' }]);
    expect(persisted.artifacts?.[0]?.parts).toEqual([
      { url: 'https://agent.example/deliveries/rapor', mediaType: 'application/pdf' },
    ]);
    expect(persisted.history?.map((m) => m.role)).toEqual(['ROLE_USER', 'ROLE_AGENT', 'ROLE_AGENT']);
    expect(persisted.metadata?.square).toMatchObject({ job: JOB_A, jobStatus: 'released' });
    await restarted.stop();
  });

  it('kurum kabulden önce iptal eder; agent durur ve job için yeni görev açılabilir', async () => {
    const worker = new Harness(db);
    await worker.start();
    await worker.openJob(JOB_B, 'çeviri');
    let stopped = false;
    worker.scripts.set(JOB_B, async (context) => {
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      stopped = true;
    });
    const institution = worker.client();
    const { task } = await institution.sendMessage({
      message: openingMessage(JOB_B, 'çeviri'),
      configuration: { returnImmediately: true },
    });
    expect((await institution.cancelTask({ id: task!.id })).status.state).toBe('TASK_STATE_CANCELED');
    await until(() => stopped);
    const again = await institution.sendMessage({
      message: openingMessage(JOB_B, 'çeviri', 'm-ikinci'),
      configuration: { returnImmediately: true },
    });
    expect(again.task?.id).not.toBe(task!.id);
    await worker.stop();
  });
});
