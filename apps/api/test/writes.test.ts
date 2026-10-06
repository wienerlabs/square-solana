// Yazma uçları: teslimat yükleme (S3 deposu), agent card barındırma ve A2A keşif yolu, politika meta verisi.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import type { AgentCard } from '@squaresdk/solana-types';
import { loadOpenApi } from '../src/openapi.js';
import { PERMISSION_INITIATE } from '../src/squads.js';
import { apiKey, login } from './fixtures/login.js';
import { CHAIN_REF, PROGRAM_IDS, PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { World, wallet } from './fixtures/world.js';

let stack: Stack;
let world: World;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL), deliveryMaxBytes: 64 });
  world = new World(stack.db, stack.rpc, stack.client);
});
afterAll(() => stack.close());
beforeEach(async () => {
  await truncate(stack.db);
  stack.rpc.reset();
});

describe('teslimat', () => {
  it('agent cüzdanı ya da agent sahibi yükler; içerik herkese açık adreste, makbuz idempotent', async () => {
    const [institutionOwner, agentOwner, agentWallet, stranger] = [wallet(), wallet(), wallet(), wallet()];
    const institution = await world.institution(institutionOwner.address);
    const agent = await world.agent(agentOwner.address, agentWallet.address);
    const job = await world.job({ institution, agentRecord: agent, agentWallet: agentWallet.address });
    const content = 'rapor: 12 makale özetlendi';

    const byAgent = stack.api({ session: await login(stack.api(), agentWallet) });
    const receipt = await byAgent.uploadDelivery(job.address, new Blob([content], { type: 'text/markdown' }));
    if (!receipt.success) throw new Error(receipt.error.message);
    expect(receipt.data).toEqual({
      workHash: sha256(content),
      deliveryUri: `${stack.deliveryBaseUrl}/${sha256(content)}`,
      contentType: 'text/markdown',
      size: Buffer.byteLength(content),
    });
    // Depodaki nesne kimliksiz okunur ve içerik hash'le doğrulanır.
    const fetched = await fetch(receipt.data.deliveryUri);
    expect(fetched.status).toBe(200);
    expect(sha256(new Uint8Array(await fetched.arrayBuffer()))).toBe(receipt.data.workHash);

    const ownerKey = await apiKey(stack, agentOwner, ['deliveries:write']);
    const again = await stack
      .api({ apiKey: ownerKey })
      .uploadDelivery(job.address, new Blob([content], { type: 'text/markdown' }));
    if (!again.success) throw new Error(JSON.stringify(again.error));
    expect(again.data.workHash).toBe(receipt.data.workHash);
    expect(await stack.db.delivery.count()).toBe(1);
    expect((await stack.db.delivery.findFirstOrThrow()).uploadedBy).toBe(agentOwner.address);

    const strangerApi = stack.api({ session: await login(stack.api(), stranger) });
    expect(await strangerApi.uploadDelivery(job.address, new Blob(['x']))).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(await byAgent.uploadDelivery(agentWallet.address, new Blob(['x']))).toMatchObject({
      error: { code: 'not_found' },
    });
    expect(await byAgent.uploadDelivery(job.address, new Blob(['x'.repeat(65)]))).toMatchObject({
      error: { code: 'invalid_input', message: 'dosya 64 bayt sınırını aşıyor' },
    });
    const octet = await byAgent.uploadDelivery(job.address, new Blob(['ikili']));
    expect(octet.success && octet.data.contentType).toBe('application/octet-stream');
  });

  it('yetki ve gövde denetimleri', async () => {
    const owner = wallet();
    const job = (
      await world.job({
        institution: await world.institution(wallet().address),
        agentRecord: await world.agent(owner.address, owner.address),
        agentWallet: owner.address,
      })
    ).address;
    expect(await stack.api().uploadDelivery(job, new Blob(['x']))).toMatchObject({ error: { code: 'unauthorized' } });
    const readOnly = await apiKey(stack, owner, ['read']);
    expect(await stack.api({ apiKey: readOnly }).uploadDelivery(job, new Blob(['x']))).toMatchObject({
      error: { code: 'forbidden' },
    });
    const session = await login(stack.api(), owner);
    const post = (body: string | FormData, headers: Record<string, string> = {}) =>
      fetch(`${stack.url}/v1/jobs/${job}/deliveries`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session}`, ...headers },
        body,
      });
    expect((await post('{}', { 'content-type': 'application/json' })).status).toBe(400);
    const twoFields = new FormData();
    twoFields.append('note', 'x');
    twoFields.append('file', new Blob(['x']));
    expect((await post(twoFields)).status).toBe(400);
    const wrongField = new FormData();
    wrongField.append('attachment', new Blob(['x']));
    expect((await post(wrongField)).status).toBe(400);
    expect((await post(new FormData())).status).toBe(400);
    const badType = new FormData();
    badType.append('file', new Blob(['x'], { type: `text/${'x'.repeat(120)}` }));
    expect(await (await post(badType)).json()).toMatchObject({ error: { code: 'invalid_input' } });
  });
});

describe('agent card', () => {
  const card = (agentRecord: string): AgentCard => ({
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Research Agent',
    description: 'Literature review agent',
    url: 'https://agents.example.com/a2a',
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      { id: 'literature-review', name: 'Literature review', description: 'Summarises papers', tags: ['research'] },
    ],
    services: [{ name: 'A2A', endpoint: 'https://agents.example.com/a2a', version: '1.0.0' }],
    registrations: [{ agentRegistry: `solana:${CHAIN_REF}:${PROGRAM_IDS.registry.toBase58()}`, agentId: agentRecord }],
    active: true,
  });

  it('kayıttan önce agentId ile, kayıttan sonra sahip yazar; keşif yolu hash’lenen baytları verir', async () => {
    const owner = wallet();
    const agentId = 'research-1';
    const [pda] = stack.client.pda.agentRecord(owner.keypair.publicKey, agentId);
    const record = pda.toBase58();
    const api = stack.api({ session: await login(stack.api(), owner) });

    expect(await api.putAgentCard(record, card(record))).toMatchObject({ error: { code: 'invalid_input' } });
    expect(await api.putAgentCard(record, card(record), { agentId: 'research-2' })).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(await api.putAgentCard(record, card(record), { agentId: 'x'.repeat(40) })).toMatchObject({
      error: { code: 'invalid_input' },
    });
    const hosting = await api.putAgentCard(record, card(record), { agentId });
    if (!hosting.success) throw new Error(hosting.error.message);
    expect(hosting.data.agentCardUri).toBe(`${PUBLIC_BASE_URL}/a/${record}/.well-known/agent-card.json`);

    const served = await fetch(`${stack.url}/a/${record}/.well-known/agent-card.json`);
    expect(served.headers.get('content-type')).toMatch(/^application\/json/);
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(sha256(bytes)).toBe(hosting.data.agentCardHash);
    expect(await stack.api().getWellKnownAgentCard(record)).toMatchObject({ name: 'Research Agent' });
    // RFC 8785: anahtar sırası değişse de aynı baytlar.
    const reordered = Object.fromEntries(Object.entries(card(record)).reverse()) as AgentCard;
    expect((await api.putAgentCard(record, reordered, { agentId })).data?.agentCardHash).toBe(
      hosting.data.agentCardHash,
    );

    // Kayıt indexlenince (zincirdeki hash kartınki) kart doğrulanmış görünür; artık sahip yazar.
    const registered = await world.agent(owner.address, owner.address, {
      address: record,
      agentCardHash: hosting.data.agentCardHash,
    });
    const view = await stack.api().getAgent(registered);
    expect(view.data).toMatchObject({ cardVerified: true, card: { name: 'Research Agent' } });
    expect((await stack.api().listAgents({ skill: 'research' })).data?.map((a) => a.address)).toEqual([registered]);
    expect((await api.putAgentCard(registered, card(registered))).success).toBe(true);
    const otherKey = await apiKey(stack, wallet(), ['agents:write']);
    expect(await stack.api({ apiKey: otherKey }).putAgentCard(registered, card(registered))).toMatchObject({
      error: { code: 'forbidden' },
    });
  });

  it('kart şeması, kayıt bağlantısı ve yetki', async () => {
    const owner = wallet();
    const record = await world.agent(owner.address, owner.address);
    const api = stack.api({ session: await login(stack.api(), owner) });
    expect(await api.putAgentCard(record, { ...card(record), url: 'http://insecure.example.com' })).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(await api.putAgentCard(record, card(owner.address))).toMatchObject({
      error: { code: 'invalid_input', message: expect.stringContaining('registrations') },
    });
    expect(await stack.api().putAgentCard(record, card(record))).toMatchObject({ error: { code: 'unauthorized' } });
    const readKey = await apiKey(stack, owner, ['read']);
    expect(await stack.api({ apiKey: readKey }).putAgentCard(record, card(record))).toMatchObject({
      error: { code: 'forbidden' },
    });
    await expect(stack.api().getWellKnownAgentCard(record)).rejects.toMatchObject({ status: 404 });
    const unknownQuery = await fetch(`${stack.url}/v1/agents/${record}/card?colour=red`, { method: 'PUT' });
    expect(unknownQuery.status).toBe(401);
  });
});

describe('politika meta verisi', () => {
  const meta = { name: 'Research spend', description: 'Literature budget', labels: ['research'], updatedAt: 0 };

  it('multisig yoksa kurum anahtarı yazar', async () => {
    const owner = wallet();
    const policy = await world.policy(await world.institution(owner.address));
    const view = await stack.api({ session: await login(stack.api(), owner) }).putPolicyMeta(policy, meta);
    if (!view.success) throw new Error(view.error.message);
    expect(view.data.meta).toMatchObject({ name: 'Research spend', labels: ['research'] });
    expect(view.data.meta!.updatedAt).toBeGreaterThan(1_700_000_000);
    expect((await stack.db.policyMeta.findFirstOrThrow()).updatedBy).toBe(owner.address);
    const stranger = stack.api({ session: await login(stack.api(), wallet()) });
    expect(await stranger.putPolicyMeta(policy, meta)).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('multisig bağlıysa Initiate yetkili üye yazar, diğer üye ve kurum anahtarı yazamaz', async () => {
    const [owner, proposer, voter] = [wallet(), wallet(), wallet()];
    const multisig = world.squadsMultisig([
      { key: proposer.address, permissions: PERMISSION_INITIATE | 2 },
      { key: voter.address, permissions: 2 },
    ]);
    const policy = await world.policy(await world.institution(owner.address, { multisig }));
    const as = async (who: typeof owner) => stack.api({ session: await login(stack.api(), who) });
    expect((await (await as(proposer)).putPolicyMeta(policy, meta)).success).toBe(true);
    expect(await (await as(voter)).putPolicyMeta(policy, meta)).toMatchObject({ error: { code: 'forbidden' } });
    expect(await (await as(owner)).putPolicyMeta(policy, meta)).toMatchObject({ error: { code: 'forbidden' } });

    // Multisig hesabı Squads multisig'i değilse yetkili doğrulanamaz; RPC düşerse 503.
    stack.rpc.setAccount(multisig.toBase58(), { owner: PROGRAM_IDS.policy.toBase58(), data: Buffer.alloc(80) });
    expect(await (await as(proposer)).putPolicyMeta(policy, meta)).toMatchObject({ error: { code: 'forbidden' } });
    const session = await as(proposer);
    stack.rpc.failWith = 500;
    expect(await session.putPolicyMeta(policy, meta)).toMatchObject({ error: { code: 'rpc_unavailable' } });
  });

  it('oturum gerekir; şema ve bulunamayan politika', async () => {
    const owner = wallet();
    const policy = await world.policy(await world.institution(owner.address));
    expect(await stack.api().putPolicyMeta(policy, meta)).toMatchObject({ error: { code: 'unauthorized' } });
    const key = await apiKey(stack, owner, ['read', 'agents:write']);
    expect(await stack.api({ apiKey: key }).putPolicyMeta(policy, meta)).toMatchObject({
      error: { code: 'unauthorized' },
    });
    const api = stack.api({ session: await login(stack.api(), owner) });
    expect(await api.putPolicyMeta(policy, { ...meta, labels: ['x'.repeat(41)] })).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(await api.putPolicyMeta(owner.address, meta)).toMatchObject({ error: { code: 'not_found' } });
  });
});
