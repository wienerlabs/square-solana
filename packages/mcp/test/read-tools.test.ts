// Okuma tool'ları: sahte API'yle, SDK'nın gerçek MCP `Client`'ı üzerinden.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, type Harness } from './helpers/harness.js';
import { address, agentView, disputeView, hex32, jobView, NOW } from './helpers/fixtures.js';

let h: Harness;
beforeEach(async () => {
  h = await connect({ write: false, apiKey: 'sqk_test' });
});
afterEach(async () => {
  await h.close();
});

describe('tool listesi', () => {
  it('okuma kipinde yalnızca beş salt okunur tool var', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'square_discover_agents',
      'square_find_work',
      'square_get_job',
      'square_get_reputation',
      'square_settlement_stats',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});

describe('square_find_work', () => {
  it('varsayılan funded işleri döner, tutar süzgeci sayfaya uygulanır', async () => {
    const agentRecord = address();
    const small = jobView({ agentRecord, amount: '500' });
    const large = jobView({ agentRecord, amount: '5000000' });
    h.api.jobs.set(small.address, small);
    h.api.jobs.set(large.address, large);
    h.api.jobs.set('x', jobView({ address: address(), status: 'open' }));

    const { isError, body } = await h.call('square_find_work', { agentRecord, maxAmount: '1000' });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ network: 'localnet', status: 'funded', total: 2, returned: 1 });
    const [job] = body.jobs as Record<string, unknown>[];
    expect(job).toMatchObject({ address: small.address, amount: '500', status: 'funded', workHash: null });
    expect(job!.deadline).toBe(new Date(small.account.deadline * 1000).toISOString());
    const request = h.api.requests.at(-1)!;
    expect(request.query).toMatchObject({ status: 'funded', agentRecord, page: '1', limit: '20' });
    expect(request.apiKey).toBe('sqk_test');
  });

  it('başka durum, kurum, politika ve alt sınır süzgeci', async () => {
    const institution = address();
    const policy = address();
    const delivered = jobView({ status: 'delivered', institution, policy, amount: '10' });
    h.api.jobs.set(delivered.address, delivered);
    const { body } = await h.call('square_find_work', {
      status: 'delivered',
      institution,
      policy,
      minAmount: '10',
      page: 1,
      limit: 5,
    });
    expect(body).toMatchObject({ status: 'delivered', returned: 1 });
    expect(body.hint).toMatch(/challengeEnd/);
    const { body: none } = await h.call('square_find_work', { status: 'delivered', minAmount: '11' });
    expect(none.returned).toBe(0);
  });

  it('geçersiz girdi şemada reddedilir', async () => {
    const result = await h.client.callTool({ name: 'square_find_work', arguments: { maxAmount: '-1' } });
    expect(result.isError).toBe(true);
  });

  it('API hatası kodu ve programError ile döner', async () => {
    h.api.failNext = { status: 503, error: { code: 'db_unavailable', message: 'veritabanı yok' } };
    const { isError, body } = await h.call('square_find_work');
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: 'square_api_error', code: 'db_unavailable', message: 'veritabanı yok' });
  });
});

describe('square_get_job', () => {
  it('durum, zaman çizelgesi, dispute ve sonraki adım', async () => {
    const job = jobView({ status: 'disputed', deliveredAt: NOW - 100, challengeEnd: NOW + 100 });
    job.account.dispute = { ...job.account.dispute, raisedAt: NOW - 50, deadline: NOW + 1000, challenger: address() };
    job.account.deliveryUri = 'https://deliveries.example/x';
    job.account.workHash = hex32(3);
    h.api.jobs.set(job.address, job);
    h.api.disputes.set(job.address, disputeView(job));
    const signature = '1'.repeat(64);
    h.api.events.push(
      {
        signature,
        slot: 20,
        blockTime: NOW - 100,
        instructionIndex: 0,
        eventIndex: 0,
        payload: {
          program: 'escrow',
          name: 'WorkSubmitted',
          data: { job: job.address, workHash: hex32(3), deliveryUri: 'u', challengeEnd: NOW + 100 },
        },
      } as never,
      {
        signature,
        slot: 10,
        blockTime: null,
        instructionIndex: 0,
        eventIndex: 0,
        payload: {
          program: 'escrow',
          name: 'JobAccepted',
          data: { job: job.address, agentWallet: job.account.agentWallet },
        },
      } as never,
    );

    const { isError, body } = await h.call('square_get_job', { job: job.address });
    expect(isError).toBe(false);
    expect(body.job).toMatchObject({ status: 'disputed', disputed: true, workHash: hex32(3) });
    expect(body.next).toMatch(/arbitrators/);
    expect(body.dispute).toMatchObject({ challenger: job.account.dispute.challenger, resolution: { kind: 'pending' } });
    expect((body.timeline as { event: string }[]).map((e) => e.event)).toEqual(['JobAccepted', 'WorkSubmitted']);
    expect(body.timelineTotal).toBe(2);
  });

  it('dispute açılmamış job için dispute okunmaz', async () => {
    const job = jobView({ status: 'accepted' });
    h.api.jobs.set(job.address, job);
    const { body } = await h.call('square_get_job', { job: job.address });
    expect(body.dispute).toBeNull();
    expect(h.api.requests.some((r) => r.path.startsWith('/v1/disputes'))).toBe(false);
  });

  it('bilinmeyen job açıklayıcı hata', async () => {
    const { isError, body } = await h.call('square_get_job', { job: address() });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: 'invalid_request' });
    expect(body.message).toMatch(/not found/);
  });

  it('her durumun sonraki adımı var', async () => {
    const { nextAction } = await import('../src/tools/discover.js');
    for (const status of [
      'open',
      'funded',
      'accepted',
      'delivered',
      'disputed',
      'resolved',
      'released',
      'refunded',
      'cancelled',
    ] as const) {
      expect(nextAction(status).length).toBeGreaterThan(10);
    }
  });
});

describe('square_settlement_stats', () => {
  it('durum sayıları, oranlar ve keeper sonuçları', async () => {
    const totals = {
      open: 1,
      funded: 2,
      accepted: 3,
      delivered: 4,
      disputed: 1,
      resolved: 0,
      released: 6,
      refunded: 2,
      cancelled: 1,
    };
    for (const [status, total] of Object.entries(totals)) h.api.totals.set(status, total);
    const disputed = jobView({ status: 'disputed' });
    h.api.disputes.set(disputed.address, disputeView(disputed));
    h.api.keeper.push({
      id: 'k1',
      job: disputed.address,
      action: 'finalizePayment',
      outcome: 'skipped',
      reason: 'challengeOpen',
      signature: null,
      keeperFee: null,
      at: NOW,
      nextAttemptAt: NOW + 60,
    });
    const { body } = await h.call('square_settlement_stats');
    expect(body.jobs).toEqual({ total: 20, byStatus: totals, escrowLocked: 10 });
    expect(body.disputes).toBe(1);
    expect(body.rates).toEqual({ releaseRate: 0.75, disputeRate: Math.round((1 / 13) * 10_000) / 10_000 });
    expect(body.keeper).toEqual({ submitted: 0, confirmed: 0, skipped: 1, failed: 0 });
    expect(body.volume).toBeNull();
  });

  it('includeVolume hacmi, ortalama süreyi ve challenge penceresini hesaplar', async () => {
    for (let i = 0; i < 3; i++) {
      const job = jobView({
        status: 'released',
        amount: '100',
        deliveredAt: NOW - 1000,
        settledAt: NOW - 1000 + 60 * (i + 1),
      });
      h.api.jobs.set(job.address, job);
    }
    const open = jobView({ status: 'delivered', challengeEnd: NOW + 3600 });
    const closed = jobView({ status: 'delivered', challengeEnd: NOW - 3600 });
    h.api.jobs.set(open.address, open);
    h.api.jobs.set(closed.address, closed);
    const { body } = await h.call('square_settlement_stats', { includeVolume: true, maxPages: 1 });
    expect(body.volume).toEqual({
      releasedAmount: '300',
      releasedJobsCounted: 3,
      averageDeliveryToSettlementSeconds: 120,
      inChallengeWindow: 1,
      complete: true,
    });
    expect(body.rates).toMatchObject({ releaseRate: 1, disputeRate: 0 });
  });

  it('boş ağda oranlar null', async () => {
    const { body } = await h.call('square_settlement_stats', { includeVolume: true });
    expect(body.rates).toEqual({ releaseRate: null, disputeRate: null });
    expect(body.volume).toMatchObject({ releasedAmount: '0', averageDeliveryToSettlementSeconds: null });
  });
});

describe('square_get_reputation', () => {
  it('agentRecord ile itibar ve screening', async () => {
    const agent = agentView({ jobsCompleted: '3' });
    h.api.agents.set(agent.address, agent);
    h.api.screenings.set(agent.account.wallet, {
      address: address(),
      account: {
        wallet: agent.account.wallet,
        status: 'clear',
        sourceHash: hex32(4),
        screenedAt: NOW - 10,
        expiresAt: NOW + 1000,
        bump: 1,
      },
      fresh: true,
      slot: 1,
      indexedAt: NOW,
    });
    const { body } = await h.call('square_get_reputation', { agentRecord: agent.address });
    const [entry] = body.agents as Record<string, unknown>[];
    expect(entry).toMatchObject({
      agentRecord: agent.address,
      did: agent.did,
      reputation: { jobsCompleted: '3', jobsFailed: '1', successRate: 0.75 },
      screening: { status: 'clear', fresh: true },
    });
  });

  it("owner ile tüm agent'ları; itibarı ve screening'i olmayan agent null alanlarla", async () => {
    const owner = address();
    h.api.agents.set('a', agentView({ owner, withReputation: false, withCard: false }));
    h.api.agents.set('b', agentView({ owner }));
    h.api.agents.set('c', agentView());
    const { body } = await h.call('square_get_reputation', { owner });
    const agents = body.agents as Record<string, unknown>[];
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ reputation: null, screening: null, name: null });
  });

  it('tam olarak bir girdi ister; bilinmeyen agent hata', async () => {
    expect((await h.call('square_get_reputation')).isError).toBe(true);
    expect((await h.call('square_get_reputation', { agentRecord: address(), owner: address() })).isError).toBe(true);
    const missing = await h.call('square_get_reputation', { agentRecord: address() });
    expect(missing.body.message).toMatch(/not found/);
  });
});

describe('square_discover_agents', () => {
  it('beceriye göre bulur, karttan bilgi verir, itibara göre sıralar', async () => {
    const low = agentView({ skills: [{ id: 'translate', tags: ['language'] }], jobsCompleted: '1' });
    const high = agentView({ skills: [{ id: 'translate', tags: ['language'] }], jobsCompleted: '9' });
    const tie = agentView({
      skills: [{ id: 'translate', tags: ['language'] }],
      jobsCompleted: '1',
      totalEarned: '9999999',
    });
    const other = agentView({ skills: [{ id: 'audit', tags: ['code'] }] });
    for (const agent of [low, high, tie, other]) h.api.agents.set(agent.address, agent);

    const { body } = await h.call('square_discover_agents', { skill: 'language' });
    const agents = body.agents as Record<string, unknown>[];
    expect(agents.map((agent) => agent.agentRecord)).toEqual([high.address, tie.address, low.address]);
    expect(agents[0]).toMatchObject({
      a2aEndpoint: 'https://agent.example/a2a',
      cardVerified: true,
      skills: [{ id: 'translate', name: 'translate', tags: ['language'] }],
    });
    expect(h.api.requests.at(-1)!.query).toMatchObject({ status: 'active', skill: 'language' });
  });

  it('fiyat ve doğrulanmış kart süzgeci', async () => {
    const cheap = agentView({
      skills: [{ id: 'audit', tags: ['code'] }],
      pricing: [{ skillId: 'audit', amount: '100' }],
    });
    const pricey = agentView({
      skills: [{ id: 'audit', tags: ['code'] }],
      pricing: [{ skillId: 'audit', amount: '900' }],
    });
    const unverified = agentView({ pricing: [{ skillId: 'translate', amount: '1' }], cardVerified: false });
    const owner = address();
    const noCard = agentView({ owner, withCard: false, withReputation: false });
    for (const agent of [cheap, pricey, unverified, noCard]) h.api.agents.set(agent.address, agent);

    const byTag = await h.call('square_discover_agents', { skill: 'code', maxPrice: '500' });
    expect((byTag.body.agents as { agentRecord: string }[]).map((a) => a.agentRecord)).toEqual([cheap.address]);
    const verified = await h.call('square_discover_agents', { maxPrice: '500', verifiedOnly: true });
    expect((verified.body.agents as { agentRecord: string }[]).map((a) => a.agentRecord)).toEqual([cheap.address]);
    const mine = await h.call('square_discover_agents', { owner, status: 'active', page: 1, limit: 10 });
    expect(mine.body.agents).toEqual([
      expect.objectContaining({ agentRecord: noCard.address, name: null, active: null, skills: [], reputation: null }),
    ]);
  });
});
