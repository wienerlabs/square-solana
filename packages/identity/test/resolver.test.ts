// Test vektörlerinin kapsamadığı yollar: RPC / kayıt hataları, izin listesi, kart indirme sınırları,
// çapraz kayıtların gidiş-dönüş doğrulaması ve Square kart şeması.
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AGENT_CARD_TYPE } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { CHAIN_REFS, squareIdentity, type ResolverOptions } from '../src/index.js';
import { cardServer, encodeRecord, TestCluster, type LogicalRecord } from './helpers/cluster.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const AGENT_SEED = new TextEncoder().encode('agent');
const registry = Keypair.generate().publicKey;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface Agent {
  did: string;
  address: PublicKey;
  record: LogicalRecord;
}

function agent(agentId: string, overrides: Partial<LogicalRecord> = {}): Agent {
  const creator = Keypair.generate().publicKey;
  const [address, bump] = PublicKey.findProgramAddressSync(
    [AGENT_SEED, creator.toBytes(), new TextEncoder().encode(agentId)],
    registry,
  );
  const record: LogicalRecord = {
    creator: creator.toBase58(),
    agentId,
    bump,
    owner: creator.toBase58(),
    wallet: creator.toBase58(),
    agentCardUri: '',
    agentCardHash: '00'.repeat(32),
    status: 'Active',
    registeredAt: 1_790_000_000,
    updatedAt: 1_790_000_000,
    ...overrides,
  };
  const did = `did:aip:solana:${CHAIN_REFS.devnet}:${registry.toBase58()}:${address.toBase58()}`;
  return { did, address, record };
}

async function put(cluster: TestCluster, a: Agent) {
  cluster.setAccount(a.address, registry, await encodeRecord(registry.toBase58(), a.record));
}

function opts(cluster: TestCluster, fetchFn: typeof fetch, extra: Partial<ResolverOptions> = {}): ResolverOptions {
  return {
    connections: { [CHAIN_REFS.devnet]: cluster.connection() },
    commitment: 'finalized',
    card: { fetch: fetchFn, maxBytes: 4096, timeoutMs: 2_000 },
    crossRegistrationLimit: 8,
    ...extra,
  };
}

const card = (body: object) => JSON.stringify(body);
const registration = (a: Agent) => ({
  agentRegistry: `solana:${CHAIN_REFS.devnet}:${registry.toBase58()}`,
  agentId: a.address.toBase58(),
});

describe('çözüm hataları', () => {
  it('kayıt yok, başka program, bozuk veri, yanlış adres', async () => {
    const cluster = new TestCluster(DEVNET_GENESIS, 9);
    const a = agent('missing');
    const o = opts(cluster, cardServer({}).fetch);
    expect((await squareIdentity.resolveDid(a.did, o)).didResolutionMetadata.error).toBe('notFound');

    const b = agent('foreign');
    cluster.setAccount(b.address, Keypair.generate().publicKey, await encodeRecord(registry.toBase58(), b.record));
    expect((await squareIdentity.resolveDid(b.did, o)).didResolutionMetadata.error).toBe('notFound');

    const c = agent('corrupt');
    const data = await encodeRecord(registry.toBase58(), c.record);
    cluster.setAccount(c.address, registry, data.subarray(0, 40));
    expect((await squareIdentity.resolveDid(c.did, o)).didResolutionMetadata.error).toBe('internalError');

    const d = agent('noise');
    cluster.setAccount(d.address, registry, Buffer.alloc(200, 7));
    expect((await squareIdentity.resolveDid(d.did, o)).didResolutionMetadata.error).toBe('notFound');

    const e = agent('moved', {});
    await put(cluster, { ...e, record: { ...e.record, bump: e.record.bump === 255 ? 254 : 255 } });
    expect((await squareIdentity.resolveDid(e.did, o)).didResolutionMetadata.error).toBe('notFound');
  });

  it('ağ hatası, desteklenmeyen zincir, yanlış küme, izin listesi, eip155', async () => {
    const cluster = new TestCluster(DEVNET_GENESIS, 9);
    const a = agent('net');
    cluster.failReads = true;
    expect(
      (await squareIdentity.resolveDid(a.did, opts(cluster, cardServer({}).fetch))).didResolutionMetadata.error,
    ).toBe('networkError');

    const none = opts(cluster, cardServer({}).fetch, { connections: {} });
    expect((await squareIdentity.resolveDid(a.did, none)).didResolutionMetadata.error).toBe('unsupportedChain');

    const mainnet = new TestCluster('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 1);
    const wrong = opts(cluster, cardServer({}).fetch, { connections: { [CHAIN_REFS.devnet]: mainnet.connection() } });
    expect((await squareIdentity.resolveDid(a.did, wrong)).didResolutionMetadata.error).toBe('unsupportedChain');
    expect(mainnet.calls).toEqual(['getGenesisHash']);

    const allow = opts(cluster, cardServer({}).fetch, { registryAllowlist: [Keypair.generate().publicKey.toBase58()] });
    expect((await squareIdentity.resolveDid(a.did, allow)).didResolutionMetadata.error).toBe('registryNotAllowed');

    const evm = 'did:aip:eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e:2';
    expect(
      (await squareIdentity.resolveDid(evm, opts(cluster, cardServer({}).fetch))).didResolutionMetadata.error,
    ).toBe('unsupportedChain');

    const v1 = 'did:aip:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU:ada-research-001';
    expect((await squareIdentity.resolveDid(v1, none)).didResolutionMetadata.error).toBe('unsupportedChain');
    cluster.failReads = false;
    expect((await squareIdentity.resolveDid(v1, opts(cluster, cardServer({}).fetch))).didResolutionMetadata.error).toBe(
      'notFound',
    );
  });

  it('genesis doğrulaması bağlantı başına bir kez yapılır', async () => {
    const cluster = new TestCluster(DEVNET_GENESIS, 9);
    const a = agent('once');
    await put(cluster, a);
    const o = opts(cluster, cardServer({}).fetch);
    await squareIdentity.resolveDid(a.did, o);
    await squareIdentity.resolveDid(a.did, o);
    expect(cluster.calls.filter((c) => c === 'getGenesisHash')).toHaveLength(1);
  });
});

describe('kart indirme', () => {
  const uri = 'https://agent.square.test/card.json';
  const body = card({ services: [] });

  it('boyut sınırı, http, desteklenmeyen şema, ipfs ağ geçidi yokken: unavailable', async () => {
    const cluster = new TestCluster(DEVNET_GENESIS, 9);
    const big = 'x'.repeat(5000);
    for (const [cardUri, served] of [
      [uri, big],
      ['http://agent.square.test/card.json', body],
      ['ftp://agent.square.test/card.json', body],
      ['ipfs://bafkreid', body],
    ] as const) {
      const a = agent(`u${cardUri.length}${served.length}`.slice(0, 32), {
        agentCardUri: cardUri,
        agentCardHash: sha(served),
      });
      await put(cluster, a);
      const result = await squareIdentity.resolveDid(a.did, opts(cluster, cardServer({ [cardUri]: served }).fetch));
      expect(result.didDocumentMetadata.agentCard).toBe('unavailable');
      expect(result.didResolutionMetadata.warnings?.[0]?.code).toBe('agentCardUnreachable');
    }
  });

  it('akış okuması da boyut sınırını uygular; yönlendirme izlenmez', async () => {
    const chunks = (n: number) =>
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < n; i += 1) controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      });
    const streaming = (async () => new Response(chunks(5), { status: 200 })) as typeof fetch;
    const redirecting = (async (_: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('redirect');
    }) as typeof fetch;
    const cluster = new TestCluster(DEVNET_GENESIS, 9);
    for (const f of [streaming, redirecting]) {
      const a = agent(`s${f === streaming ? 1 : 2}`, { agentCardUri: uri, agentCardHash: sha(body) });
      await put(cluster, a);
      expect((await squareIdentity.resolveDid(a.did, opts(cluster, f))).didDocumentMetadata.agentCard).toBe(
        'unavailable',
      );
    }
  });

  it('https olmayan ipfs ağ geçidi kabul edilmez', async () => {
    const cluster = new TestCluster(DEVNET_GENESIS, 9);
    const a = agent('gw', { agentCardUri: 'ipfs://bafkreid', agentCardHash: sha(body) });
    await put(cluster, a);
    const o = opts(cluster, cardServer({}).fetch);
    const result = await squareIdentity.resolveDid(a.did, {
      ...o,
      card: { ...o.card, ipfsGateway: 'http://gw.test/ipfs/' },
    });
    expect(result.didResolutionMetadata.error).toBe('internalError');
  });

  it('fetchAgentCard Square kart şemasını uygular; verifyAgentCardHash', async () => {
    const owner = agent('square');
    const valid = {
      type: AGENT_CARD_TYPE,
      name: 'Scribe',
      description: 'Drafts documents.',
      url: 'https://scribe.square.test/a2a',
      version: '1.0.0',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'draft', name: 'Draft', description: 'Drafts a document.', tags: ['writing'] }],
      services: [{ name: 'A2A', endpoint: 'https://scribe.square.test/a2a' }],
      registrations: [registration(owner)],
    };
    const server = cardServer({
      [uri]: card(valid),
      'https://bad.square.test/card.json': card({ ...valid, services: [{ name: 'MCP', endpoint: 'https://x.test' }] }),
    });
    const options = { fetch: server.fetch, maxBytes: 4096, timeoutMs: 2_000 };
    const fetched = await squareIdentity.fetchAgentCard(uri, options);
    expect(fetched.card.name).toBe('Scribe');
    expect(squareIdentity.verifyAgentCardHash(fetched.bytes, Buffer.from(sha(card(valid)), 'hex'))).toBe(true);
    expect(squareIdentity.verifyAgentCardHash(fetched.bytes, new Uint8Array(32))).toBe(false);
    await expect(squareIdentity.fetchAgentCard('https://bad.square.test/card.json', options)).rejects.toThrow(/A2A/);
    await expect(squareIdentity.fetchAgentCard('https://missing.square.test/card.json', options)).rejects.toThrow(
      /dereferenced/,
    );
  });
});

describe('çapraz kayıtlar (v2 §8)', () => {
  it('geri listeleyen doğrulanır; listelemeyen, EVM ve sınır dışı doğrulanmaz; eşlenemeyen uyarı verir', async () => {
    const cluster = new TestCluster(DEVNET_GENESIS, 9);
    const self = agent('self');
    const partner = agent('partner');
    const stranger = agent('stranger');
    const extra = agent('extra');
    const evm = { agentRegistry: 'eip155:1:0x8004a818bfb912233c491871b3d84c89a494bd9e', agentId: '22' };
    const selfCard = card({
      services: [{ name: 'A2A', endpoint: 'https://self.test/a2a' }],
      registrations: [
        registration(self),
        registration(partner),
        registration(stranger),
        evm,
        registration(extra),
        { agentRegistry: 'solana:bad', agentId: 'x' },
        { agentId: 3 },
      ],
    });
    const partnerCard = card({ registrations: [registration(partner), registration(self)] });
    const strangerCard = card({ registrations: [registration(stranger)] });
    const uri = (a: Agent) => `https://cards.test/${a.record.agentId}.json`;
    for (const [a, body] of [
      [self, selfCard],
      [partner, partnerCard],
      [stranger, strangerCard],
    ] as const) {
      await put(cluster, { ...a, record: { ...a.record, agentCardUri: uri(a), agentCardHash: sha(body) } });
    }
    const server = cardServer({ [uri(self)]: selfCard, [uri(partner)]: partnerCard, [uri(stranger)]: strangerCard });
    const result = await squareIdentity.resolveDid(
      self.did,
      opts(cluster, server.fetch, { crossRegistrationLimit: 3 }),
    );
    expect(result.didDocumentMetadata.crossRegistrations).toEqual({
      verified: [partner.did],
      unverified: [stranger.did, `did:aip:${evm.agentRegistry}:${evm.agentId}`, extra.did],
    });
    expect(result.didResolutionMetadata.warnings?.map((w) => w.code)).toEqual([
      'crossRegistrationMalformed',
      'crossRegistrationLimit',
    ]);
  });
});
