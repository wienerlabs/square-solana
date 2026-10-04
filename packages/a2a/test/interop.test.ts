// Birlikte çalışabilirlik: A2A projesinin resmi JavaScript istemcisi (@a2a-js/sdk, yalnızca test
// bağımlılığı) bu sunucuyla v1.0 JSON-RPC bağlamasında konuşabilmeli.
import { AgentCard, CancelTaskRequest, GetTaskRequest, SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB_A, JOB_B } from './helpers/fixtures.js';
import { Harness, KEY_A, openingMessage } from './helpers/harness.js';

let db: IsolatedDatabase;
let h: Harness;

beforeAll(async () => {
  db = await startIsolatedDatabase();
});

afterAll(async () => {
  await h?.stop();
  await db?.stop();
});

beforeEach(async () => {
  await h?.stop();
  await db.truncate();
  h = new Harness(db);
  await h.start();
});

async function officialClient() {
  const card = AgentCard.fromJSON({
    name: 'Square test agent',
    description: 'A2A v1.0 birlikte çalışabilirlik testi',
    supportedInterfaces: [{ url: h.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [],
  });
  const fetchWithKey: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('x-api-key', KEY_A);
    return fetch(input, { ...init, headers });
  };
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl: fetchWithKey })],
    }),
  );
  return factory.createFromAgentCard(card);
}

describe('@a2a-js/sdk istemcisi', () => {
  it('SendMessage, GetTask ve CancelTask', async () => {
    await h.openJob(JOB_A, 'a');
    const client = await officialClient();
    const sent = await client.sendMessage(
      SendMessageRequest.fromJSON({ message: openingMessage(JOB_A, 'a'), configuration: { returnImmediately: true } }),
    );
    expect('status' in sent).toBe(true);
    const task = sent as Extract<typeof sent, { status?: unknown }>;
    expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(task.contextId).toBe(JOB_A);

    const fetched = await client.getTask(GetTaskRequest.fromJSON({ id: task.id }));
    expect(fetched.id).toBe(task.id);
    expect(fetched.history.length).toBe(1);

    const canceled = await client.cancelTask(CancelTaskRequest.fromJSON({ id: task.id }));
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  });

  it('SendStreamingMessage akışını okur', async () => {
    await h.openJob(JOB_B, 'b');
    h.scripts.set(JOB_B, async (context) => {
      await h.chain.setStatus(JOB_B, 'accepted');
      await context.working('çalışıyor');
      await context.addArtifact({ artifactId: 'sonuç', parts: [{ text: 'tamam' }] });
      await h.chain.setStatus(JOB_B, 'delivered');
      await context.complete('bitti');
    });
    const client = await officialClient();
    const kinds: string[] = [];
    for await (const event of client.sendMessageStream(
      SendMessageRequest.fromJSON({ message: openingMessage(JOB_B, 'b') }),
    )) {
      kinds.push(event.payload?.$case ?? 'yok');
    }
    expect(kinds).toEqual(['task', 'statusUpdate', 'artifactUpdate', 'statusUpdate']);
  });
});
