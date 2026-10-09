// register_agent yardımcısı: kart adresi ve hash'i zincire yazılır; değişiklik yoksa tx gönderilmez, kart ya da
// cüzdan değişince update_agent. API barındırmasında hash agent'ın kanonik baytlarıyla aynı olmalı.
import { Keypair } from '@solana/web3.js';
import type { TaskStore } from '@squaresdk/solana-a2a';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent.js';
import type { AgentOptions } from '../src/types.js';
import { API_KEY, API_URL, FakeApi, PUBLIC_URL, STATS } from './helpers/harness.js';
import { PROGRAM_IDS, SimChain } from './helpers/sim.js';

const hex = (bytes: readonly number[]) => Buffer.from(bytes).toString('hex');

async function setup(overrides: Partial<AgentOptions> = {}, sim = new SimChain(), api = new FakeApi()) {
  await sim.setConfig();
  const signer = (overrides.signer as Keypair | undefined) ?? Keypair.generate();
  const agent = await createAgent({
    name: 'Kayıt Ajanı',
    description: 'Kayıt testleri',
    version: '1.0.0',
    publicUrl: PUBLIC_URL,
    agentId: 'kayit-ajani',
    capabilities: [STATS],
    handler: async () => 'x',
    signer,
    connection: sim.connection(),
    programIds: PROGRAM_IDS,
    api: { baseUrl: API_URL, apiKey: API_KEY, fetch: api.fetch },
    // Kayıt görev deposuna dokunmaz.
    store: {} as TaskStore,
    authenticate: () => null,
    ...overrides,
  });
  return { sim, api, signer, agent };
}

describe('register', () => {
  it('self barındırma: register_agent kart adresini, hash’ini ve cüzdanı yazar; tekrarında tx yok', async () => {
    const { sim, signer, agent } = await setup();
    const result = await agent.register();
    expect(result.status).toBe('registered');
    expect(result.agentCardUri).toBe(`${PUBLIC_URL}/.well-known/agent-card.json`);
    expect(result.agentCardHash).toBe(agent.cardHash);
    expect(result.signature).not.toBeNull();
    expect(sim.sent.map((ix) => ix.name)).toEqual(['registerAgent']);
    const ix = sim.sent[0]!;
    expect(ix.data.agentId).toBe('kayit-ajani');
    expect(ix.signers).toEqual([signer.publicKey.toBase58()]);

    const record = sim.agentRecord(agent.agentRecord)!;
    expect(record.owner.equals(signer.publicKey)).toBe(true);
    expect(record.wallet.equals(signer.publicKey)).toBe(true);
    expect(record.agentCardUri).toBe(agent.cardUrl);
    expect(hex(record.agentCardHash)).toBe(agent.cardHash);

    const again = await agent.register();
    expect(again).toMatchObject({ status: 'unchanged', signature: null });
    expect(sim.sent).toHaveLength(1);
  });

  it('kart değişince update_agent', async () => {
    const first = await setup();
    await first.agent.register();
    const { agent } = await setup({ version: '2.0.0', signer: first.signer }, first.sim, first.api);
    expect(agent.cardHash).not.toBe(first.agent.cardHash);
    const result = await agent.register();
    expect(result.status).toBe('updated');
    // Cüzdan değişmedi: açık işler listelenmez.
    expect(result.openPolicyJobs).toEqual([]);
    expect(first.sim.sent.map((ix) => ix.name)).toEqual(['registerAgent', 'updateAgent']);
    expect(hex(first.sim.agentRecord(agent.agentRecord)!.agentCardHash)).toBe(agent.cardHash);
  });

  it('cüzdan değişince update_agent; kapanmamış policy’li işler bildirilir (ADR 0028)', async () => {
    const owner = Keypair.generate();
    const first = await setup({ owner: owner.publicKey });
    await first.agent.register({ owner });
    const { agentRecord } = first.agent;
    const open = Keypair.generate().publicKey;
    const settled = Keypair.generate().publicKey;
    const policyless = Keypair.generate().publicKey;
    for (const [address, status, policy] of [
      [open, 'funded', Keypair.generate().publicKey],
      [settled, 'released', Keypair.generate().publicKey],
      [policyless, 'funded', null],
    ] as const) {
      await first.sim.setJob(address, {
        ...(policy ? { policy } : {}),
        institution: Keypair.generate().publicKey,
        agentRecord,
        agentWallet: first.signer.publicKey,
        amount: 4_000_000n,
        specHash: '00'.repeat(32),
        status,
        deadline: Math.floor(Date.now() / 1000) + 600,
      });
    }
    // Başka bir kaydın işi listeye girmez.
    await first.sim.setJob(Keypair.generate().publicKey, {
      policy: Keypair.generate().publicKey,
      institution: Keypair.generate().publicKey,
      agentRecord: Keypair.generate().publicKey,
      agentWallet: first.signer.publicKey,
      amount: 4_000_000n,
      specHash: '00'.repeat(32),
      status: 'funded',
      deadline: Math.floor(Date.now() / 1000) + 600,
    });

    const logs: string[] = [];
    const { agent } = await setup(
      { owner: owner.publicKey, logger: { info: (line) => logs.push(line), error: () => {} } },
      first.sim,
      first.api,
    );
    const result = await agent.register({ owner });
    expect(result.status).toBe('updated');
    expect(result.openPolicyJobs.map((job) => job.toBase58())).toEqual([open.toBase58()]);
    expect(logs.join('\n')).toContain(open.toBase58());
    expect(logs.join('\n')).toContain('ADR 0028');

    // Değişiklik yoksa tx de liste de yok.
    const again = await agent.register({ owner });
    expect(again).toMatchObject({ status: 'unchanged', signature: null, openPolicyJobs: [] });
  });

  it('API barındırması: putAgentCard agentId ile çağrılır, zincire API adresi yazılır', async () => {
    const { sim, api, agent } = await setup();
    const result = await agent.register({ hosting: 'api' });
    expect(api.cards).toHaveLength(1);
    expect(api.cards[0]).toMatchObject({
      agentRecord: agent.agentRecord.toBase58(),
      agentId: 'kayit-ajani',
      apiKey: API_KEY,
    });
    expect(result.agentCardUri).toBe(`${API_URL}/a/${agent.agentRecord.toBase58()}/.well-known/agent-card.json`);
    expect(result.agentCardHash).toBe(agent.cardHash);
    expect(sim.agentRecord(agent.agentRecord)!.agentCardUri).toBe(result.agentCardUri);
  });

  it('API farklı hash dönerse kayıt yapılmaz', async () => {
    const { sim, api, agent } = await setup();
    api.cardHashOverride = 'cd'.repeat(32);
    await expect(agent.register({ hosting: 'api' })).rejects.toThrow('aynı değil');
    expect(sim.sent).toEqual([]);
  });

  it('API barındırması api olmadan yapılamaz', async () => {
    const { agent } = await setup({
      api: undefined,
      delivery: { upload: async () => ({ workHash: '00'.repeat(32), deliveryUri: 'x', contentType: 'x', size: 0 }) },
    });
    await expect(agent.register({ hosting: 'api' })).rejects.toThrow("hosting 'api'");
  });

  it('sahip signer değilse sahibin imzacısı gerekir', async () => {
    const owner = Keypair.generate();
    const { sim, signer, agent } = await setup({ owner: owner.publicKey });
    expect(agent.agentRecord.equals(sim.client.pda.agentRecord(owner.publicKey, 'kayit-ajani')[0])).toBe(true);
    await expect(agent.register()).rejects.toThrow('options.owner');
    await expect(agent.register({ owner: Keypair.generate() })).rejects.toThrow('kaydın sahibi');
    const result = await agent.register({ owner });
    expect(result.status).toBe('registered');
    expect(new Set(sim.sent[0]!.signers)).toEqual(new Set([signer.publicKey.toBase58(), owner.publicKey.toBase58()]));
    expect(sim.agentRecord(agent.agentRecord)!.wallet.equals(signer.publicKey)).toBe(true);
  });

  it('kart adresi 200 baytı aşarsa reddedilir', async () => {
    const { agent } = await setup({ publicUrl: `${PUBLIC_URL}/${'a'.repeat(180)}` });
    await expect(agent.register()).rejects.toThrow('200 baytı');
  });
});
