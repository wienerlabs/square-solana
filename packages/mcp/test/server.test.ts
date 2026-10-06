// Sunucunun araçları, MCP SDK'nın bellek içi taşımasıyla gerçek bir MCP istemcisinden çağrılır; zincir bellektedir.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { workHash } from '@squaresdk/solana-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SquareMcpConfig } from '../src/config.js';
import { createSquareMcpServer, SERVER_INSTRUCTIONS } from '../src/server.js';
import { config, USDC, World } from './helpers/world.js';

let world: World;
let client: Client;
const closers: (() => Promise<void>)[] = [];

async function connect(overrides: Partial<SquareMcpConfig> = {}) {
  const server = createSquareMcpServer({ config: config(overrides), connection: world.connection });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
  closers.push(() => mcp.close());
  return mcp;
}

const call = async (name: string, args: Record<string, unknown> = {}, mcp = client) =>
  (await mcp.callTool({ name, arguments: args })) as CallToolResult;
/** Aracın JSON yanıtı; alanları beklentiler denetler. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- serbest JSON, iç içe alanlara erişim için.
type ToolJson = Record<string, any>;
const json = (result: CallToolResult): ToolJson => {
  const [content] = result.content;
  if (result.isError || content?.type !== 'text') throw new Error(JSON.stringify(result.content));
  return JSON.parse(content.text) as ToolJson;
};
const errorText = (result: CallToolResult) => {
  expect(result.isError).toBe(true);
  const [content] = result.content;
  return content?.type === 'text' ? content.text : '';
};

beforeEach(async () => {
  world = await new World().init();
  client = await connect();
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('sunucu', () => {
  it('araçlar, yönergeler ve açıklamalar; okuma araçları salt okunur işaretli', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'square_find_work',
      'square_get_job',
      'square_settlement_stats',
      'square_get_reputation',
      'square_discover_agents',
      'square_create_job',
      'square_fund_job',
      'square_accept_job',
      'square_submit_work',
      'square_send_transaction',
    ]);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
    expect(readOnly).toHaveLength(5);
    expect(readOnly.every((name) => !/create|fund|accept|submit|send/.test(name))).toBe(true);
  });
});

describe('okuma araçları', () => {
  it('iş bulma: agent kaydına ve duruma göre süzer, tutar sınırı USDC, yeniden eskiye', async () => {
    const agent = await world.agent();
    const older = await world.job({ agentRecord: agent.address, amount: 2_000_000, createdAt: 1_791_000_000 });
    const newer = await world.job({ agentRecord: agent.address, amount: 7_500_000, createdAt: 1_791_000_500 });
    await world.job({ agentRecord: agent.address, status: 'accepted' });
    await world.job({ amount: 3_000_000 });
    const mine = json(await call('square_find_work', { agentRecord: agent.address.toBase58() }));
    expect(mine['jobs'].map((job: { address: string }) => job.address)).toEqual([newer.toBase58(), older.toBase58()]);
    expect(mine['jobs'][0]).toMatchObject({ status: 'funded', amount: '7500000', amountUi: '7.5' });
    expect(mine['jobs'][0]['explorer']).toContain('?cluster=devnet');
    const cheap = json(await call('square_find_work', { maxAmount: '3', minAmount: '2.5' }));
    expect(cheap).toMatchObject({ total: 1 });
    const accepted = json(await call('square_find_work', { status: 'accepted', limit: 1 }));
    expect(accepted).toMatchObject({ status: 'accepted', total: 1, next: null });
    expect(errorText(await call('square_find_work', { maxAmount: '1.0000001' }))).toMatch(/6 ondalık/);
  });

  it('job ve alacak listelemesi; olmayan job hata', async () => {
    const job = await world.job({ status: 'delivered' });
    await world.claim(job);
    const result = json(await call('square_get_job', { job: job.toBase58() }));
    expect(result['job']).toMatchObject({ address: job.toBase58(), status: 'delivered' });
    expect(result['claim']).toMatchObject({ job: job.toBase58(), status: 'listed' });
    expect(errorText(await call('square_get_job', { job: Keypair.generate().publicKey.toBase58() }))).toMatch(
      /job bulunamadı/,
    );
  });

  it('istatistik: durum sayıları, kasadaki ve ödenen USDC, başka mint’teki işler ayrı', async () => {
    await world.job({ status: 'funded', amount: 1_000_000 });
    await world.job({ status: 'delivered', amount: 2_500_000 });
    await world.job({ status: 'released', amount: 4_000_000 });
    await world.job({ status: 'funded', amount: 9_000_000, mint: Keypair.generate().publicKey });
    const stats = json(await call('square_settlement_stats'));
    expect(stats).toMatchObject({
      settlementMint: USDC.toBase58(),
      jobs: 4,
      escrowedUsdc: '3.5',
      releasedUsdc: '4',
      jobsInOtherMints: 1,
    });
    expect(stats['byStatus']).toMatchObject({ funded: 2, delivered: 1, released: 1, open: 0 });
  });

  it('itibar: agent kaydıyla ya da sahibin bütün kayıtlarıyla', async () => {
    const owner = Keypair.generate().publicKey;
    const known = await world.agent({ owner, agentId: 'a', reputation: { completed: 3, earned: 12_000_000 } });
    await world.agent({ owner, agentId: 'b' });
    const one = json(await call('square_get_reputation', { agentRecord: known.address.toBase58() }));
    expect(one['agents'][0]).toMatchObject({
      agentId: 'a',
      reputation: { jobsCompleted: '3', totalEarnedUsdc: '12', lastJobAtIso: expect.stringMatching(/^2026-/) },
    });
    const all = json(await call('square_get_reputation', { owner: owner.toBase58() }));
    expect(all['agents'].map((agent: { agentId: string }) => agent.agentId).sort()).toEqual(['a', 'b']);
    expect(all['agents'].find((agent: { agentId: string }) => agent.agentId === 'b').reputation).toBeNull();
    expect(errorText(await call('square_get_reputation', {}))).toMatch(/agentRecord ya da owner/);
    expect(
      errorText(await call('square_get_reputation', { agentRecord: Keypair.generate().publicKey.toBase58() })),
    ).toMatch(/agent kaydı bulunamadı/);
  });

  it('keşif: duruma göre, itibara göre sıralı; beceri kartın hash’i doğrulanarak', async () => {
    const card = (skill: string) =>
      JSON.stringify({
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        name: skill,
        description: 'agent',
        url: 'https://agent.test/a2a',
        version: '1',
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{ id: skill, name: skill, description: skill, tags: ['solana'] }],
        services: [{ name: 'A2A', endpoint: 'https://agent.test/a2a' }],
        registrations: [{ agentRegistry: `solana:${'1'.repeat(32)}:${'1'.repeat(32)}`, agentId: '1'.repeat(32) }],
      });
    const served = new Map<string, string>();
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const body = served.get(String(input));
      return body ? new Response(body) : new Response('missing', { status: 404 });
    }) as typeof fetch;
    try {
      const analysis = card('wallet-analysis');
      served.set('https://cards.test/a.json', analysis);
      served.set('https://cards.test/b.json', card('translation'));
      const a = await world.agent({
        agentId: 'a',
        agentCardUri: 'https://cards.test/a.json',
        agentCardHash: workHash(analysis),
        reputation: { completed: 1, earned: 1 },
      });
      await world.agent({
        agentId: 'b',
        agentCardUri: 'https://cards.test/b.json',
        agentCardHash: new Uint8Array(32),
        reputation: { completed: 5, earned: 1 },
      });
      await world.agent({ agentId: 'c', status: 'inactive' });
      const ranked = json(await call('square_discover_agents'));
      expect(ranked['agents'].map((agent: { agentId: string }) => agent.agentId)).toEqual(['b', 'a']);
      const skilled = json(await call('square_discover_agents', { skill: 'WALLET' }));
      expect(skilled['agents']).toEqual([
        expect.objectContaining({
          agentRecord: a.address.toBase58(),
          skills: [expect.objectContaining({ id: 'wallet-analysis' })],
        }),
      ]);
      // b'nin kartının hash'i tutmuyor: eşleşmez, kullanılamayan kart olarak sayılır.
      expect(skilled).toMatchObject({ cardsChecked: 2, cardsUnusable: 1 });
      const inactive = json(await call('square_discover_agents', { status: 'inactive' }));
      expect(inactive['agents'].map((agent: { agentId: string }) => agent.agentId)).toEqual(['c']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('yazma araçları imza ister', () => {
  async function fundable() {
    const institution = Keypair.generate();
    const agent = Keypair.generate();
    const record = await world.agent({ owner: agent.publicKey });
    const job = await world.job({
      status: 'open',
      institution: institution.publicKey,
      agentRecord: record.address,
      agentWallet: agent.publicKey,
    });
    await world.screening(institution.publicKey);
    await world.screening(agent.publicKey);
    return { institution, agent, record, job };
  }

  it('anahtar yoksa imzasız tx döner, zincire hiçbir şey gönderilmez', async () => {
    const { institution, agent, record, job } = await fundable();
    const created = json(
      await call('square_create_job', {
        agentRecord: record.address.toBase58(),
        title: 'Wallet analysis',
        description: 'Analyse the wallet.',
        amount: '25',
        deadline: new Date(Date.now() + 86_400_000).toISOString(),
        institution: institution.publicKey.toBase58(),
      }),
    );
    expect(created).toMatchObject({ status: 'signatureRequired', signers: [institution.publicKey.toBase58()] });
    expect(created['job']).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const tx = VersionedTransaction.deserialize(Buffer.from(created['transaction'], 'base64'));
    expect(tx.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    expect(tx.message.staticAccountKeys[0]!.equals(institution.publicKey)).toBe(true);

    const funded = json(await call('square_fund_job', { job: job.toBase58() }));
    expect(funded).toMatchObject({ status: 'signatureRequired', signers: [institution.publicKey.toBase58()] });
    const accepted = json(await call('square_accept_job', { job: job.toBase58() }));
    expect(accepted).toMatchObject({ status: 'signatureRequired', signers: [agent.publicKey.toBase58()] });
    const submitted = json(
      await call('square_submit_work', {
        job: job.toBase58(),
        deliveryUri: 'https://delivery.test/x',
        workHash: 'ab'.repeat(32),
      }),
    );
    expect(submitted).toMatchObject({ status: 'signatureRequired', workHash: 'ab'.repeat(32) });
    expect(world.chain.sent).toHaveLength(0);

    // İmzasız tx'i göndermek reddedilir; imzalanmışı gönderilir.
    expect(
      errorText(
        await call('square_send_transaction', {
          transaction: funded['transaction'],
          lastValidBlockHeight: funded['lastValidBlockHeight'],
        }),
      ),
    ).toMatch(/eksik imza/);
    const signed = VersionedTransaction.deserialize(Buffer.from(funded['transaction'], 'base64'));
    signed.sign([institution]);
    const sent = json(
      await call('square_send_transaction', {
        transaction: Buffer.from(signed.serialize()).toString('base64'),
        lastValidBlockHeight: funded['lastValidBlockHeight'],
      }),
    );
    expect(sent).toMatchObject({ status: 'confirmed' });
    expect(world.chain.sent).toHaveLength(1);
    expect(errorText(await call('square_send_transaction', { transaction: '###', lastValidBlockHeight: 1 }))).toMatch(
      /base64/,
    );
  });

  it('anahtar rolünse imzalayıp gönderir; başka rolün tx’ini kurmaz', async () => {
    const { institution, agent, job } = await fundable();
    const asInstitution = await connect({ signer: institution });
    const funded = json(await call('square_fund_job', { job: job.toBase58() }, asInstitution));
    expect(funded).toMatchObject({ status: 'confirmed', explorer: expect.stringContaining('/tx/') });
    const [tx] = world.chain.sent;
    expect(tx!.message.staticAccountKeys[0]!.equals(institution.publicKey)).toBe(true);
    expect(tx!.signatures[0]!.some((byte) => byte !== 0)).toBe(true);
    const institutionAta = getAssociatedTokenAddressSync(USDC, institution.publicKey, true);
    expect(tx!.message.staticAccountKeys.some((key) => key.equals(institutionAta))).toBe(true);

    expect(errorText(await call('square_accept_job', { job: job.toBase58() }, asInstitution))).toMatch(
      new RegExp(`${agent.publicKey.toBase58()} imzalar`),
    );
    expect(world.chain.sent).toHaveLength(1);

    world.chain.sendResult = { InstructionError: [1, { Custom: 6000 }] };
    const asAgent = await connect({ signer: agent });
    expect(errorText(await call('square_accept_job', { job: job.toBase58() }, asAgent))).toMatch(/zincirde başarısız/);
  });

  it('job açma: rol ve girdi denetimleri; anahtar varsa kurum odur', async () => {
    const { institution, record } = await fundable();
    const base = {
      agentRecord: record.address.toBase58(),
      title: 't',
      description: 'd',
      amount: '1',
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
    };
    expect(errorText(await call('square_create_job', base))).toMatch(/institution verilmeli/);
    expect(
      errorText(
        await call('square_create_job', {
          ...base,
          institution: institution.publicKey.toBase58(),
          challengePeriodSeconds: 10,
        }),
      ),
    ).toMatch(/challenge penceresi/);
    expect(
      errorText(
        await call('square_create_job', {
          ...base,
          institution: institution.publicKey.toBase58(),
          deadline: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toMatch(/gelecekte/);
    const signed = await connect({ signer: institution });
    expect(
      errorText(
        await call('square_create_job', { ...base, institution: Keypair.generate().publicKey.toBase58() }, signed),
      ),
    ).toMatch(/sunucunun anahtarı/);
    expect(json(await call('square_create_job', base, signed))).toMatchObject({ status: 'confirmed' });
  });

  it('teslim: içerik API’ye yüklenir; yapılandırma yoksa ya da girdiler karışıksa reddedilir', async () => {
    const { job } = await fundable();
    expect(errorText(await call('square_submit_work', { job: job.toBase58(), content: 'x' }))).toMatch(
      /SQUARE_API_URL/,
    );
    expect(errorText(await call('square_submit_work', { job: job.toBase58() }))).toMatch(/deliveryUri \+ workHash/);
    expect(
      errorText(
        await call('square_submit_work', { job: job.toBase58(), content: 'x', deliveryUri: 'https://d.test/x' }),
      ),
    ).toMatch(/content ya da/);
    const requests: { url: string; key: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), key: new Headers(init?.headers).get('x-api-key') });
      const hash = workHash('the report');
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            workHash: Buffer.from(hash).toString('hex'),
            deliveryUri: `https://deliveries.test/${Buffer.from(hash).toString('hex')}`,
            contentType: 'text/markdown',
            size: 10,
          },
          error: null,
          meta: { requestId: 'r', page: null, limit: null, total: null },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const withApi = await connect({ api: { url: 'https://api.test', apiKey: 'sk_test' } });
      const result = json(
        await call(
          'square_submit_work',
          { job: job.toBase58(), content: 'the report', contentType: 'text/markdown' },
          withApi,
        ),
      );
      expect(result).toMatchObject({
        status: 'signatureRequired',
        workHash: Buffer.from(workHash('the report')).toString('hex'),
      });
      expect(requests).toEqual([{ url: `https://api.test/v1/jobs/${job.toBase58()}/deliveries`, key: 'sk_test' }]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('alan konumları', () => {
  it('Job ve AgentRecord süzgeçleri IDL’den hesaplanır', async () => {
    const { fieldOffset, variantIndex } = await import('../src/chain.js');
    const { SQUARE_IDLS } = await import('@squaresdk/solana-sdk');
    const escrow = SQUARE_IDLS.escrow as never;
    expect(fieldOffset(escrow, 'Job', 'institution')).toBe(8);
    expect(fieldOffset(escrow, 'Job', 'agent_record')).toBe(40);
    expect(fieldOffset(escrow, 'Job', 'status')).toBe(208);
    expect(variantIndex(escrow, 'JobStatus', 'funded')).toBe(1);
    expect(() => fieldOffset(escrow, 'Job', 'delivery_uri')).toThrow(/değişken boyutlu/);
    expect(() => fieldOffset(escrow, 'AgentReputation', 'nope')).toThrow(/alanı yok/);
    expect(() => fieldOffset(escrow, 'JobStatus', 'x')).toThrow(/yapı değil/);
    expect(() => variantIndex(escrow, 'JobStatus', 'nope')).toThrow(/yok/);
    expect(() => variantIndex(escrow, 'Job', 'x')).toThrow(/enum değil/);
  });
});
