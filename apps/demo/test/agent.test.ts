import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import type { Agent } from '@squaresdk/solana-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  callerGrants,
  demoAgentOptions,
  serveDemoAgent,
  sha256Hex,
  type DemoAgent,
  type DemoAgentParams,
} from '../src/agent.js';
import { createDeliveryStore } from '../src/delivery.js';
import { parseDemoConfig, requireDemo } from '../src/demo-config.js';
import { ACCOUNT_REPORT_ID } from '../src/report.js';
import { IDS, rawDemoConfig, scenario } from './helpers.js';

describe('callerGrants', () => {
  it("anahtarın yalnızca SHA-256'sı kurum adresleriyle verilir", () => {
    const institution = Keypair.generate().publicKey.toBase58();
    expect(callerGrants('k'.repeat(32), [institution])).toEqual([
      { keySha256: createHash('sha256').update('k'.repeat(32)).digest('hex'), institutions: [institution] },
    ]);
    expect(callerGrants(null, [])).toEqual([]);
    expect(() => callerGrants('kısa', [institution])).toThrow(/en az 16/);
    expect(() => callerGrants('k'.repeat(32), [])).toThrow(/kurum/);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('demoAgentOptions', () => {
  const settings = (agent: Record<string, unknown> = {}, demo: Record<string, unknown> = {}) =>
    requireDemo(parseDemoConfig(rawDemoConfig({ agent, demo }), '/srv/demo', {})).agent;
  const params = (overrides: Partial<DemoAgentParams> = {}): DemoAgentParams => ({
    settings: settings(),
    signer: Keypair.generate(),
    connection: {} as Connection,
    commitment: 'confirmed',
    programIds: {
      registry: new PublicKey(IDS.registry),
      policy: new PublicKey(IDS.policy),
      verifier: new PublicKey(IDS.verifier),
      escrow: new PublicKey(IDS.escrow),
    },
    callers: [],
    listClaims: false,
    tx: {},
    ...overrides,
  });
  const deliveries = createDeliveryStore('https://agent.example.org');

  it('alacak yalnızca açıkça istenince ve indirim tanımlıysa listelenir', () => {
    expect(demoAgentOptions(params(), deliveries).autoListClaim).toBeUndefined();
    expect(demoAgentOptions(params({ listClaims: true }), deliveries).autoListClaim).toEqual({ discountBps: 300 });
    expect(
      demoAgentOptions(
        params({
          listClaims: true,
          // Alacak satışlı senaryo (ret senaryosu dahil) indirim ister; burada yalnızca onay senaryosu var.
          settings: settings({ autoListClaimBps: undefined }, { scenarios: { approved: scenario() } }),
        }),
        deliveries,
      ).autoListClaim,
    ).toBeUndefined();
  });

  it('tek beceri, kendi teslimat deposu ve geçersiz spec için kabul öncesi ret', async () => {
    const options = demoAgentOptions(params(), deliveries);
    expect(options.capabilities.map((capability) => capability.id)).toEqual([ACCOUNT_REPORT_ID]);
    expect(options.delivery).toBe(deliveries);
    const admit = options.admit!;
    expect(await admit({ spec: { accounts: [] } } as never)).toMatch(/spec\.accounts/);
    expect(await admit({ spec: { accounts: [IDS.escrow] } } as never)).toMatch(/spec\.signatures/);
    expect(await admit({ spec: { accounts: [IDS.escrow], signatures: 0 } } as never)).toBeNull();
    expect(await admit({ spec: { accounts: [IDS.escrow], signatures: 11 } } as never)).toMatch(/0 ile 10 arası/);
  });

  it("tekrar deneme ve teslim payı yapılandırmadan agent-sdk'ya geçer", () => {
    expect(demoAgentOptions(params(), deliveries).retry).toEqual({
      minDelayMs: 1_000,
      maxDelayMs: 30_000,
      submitMarginSeconds: 30,
    });
  });

  it('çağıran yoksa her istek reddedilir; anahtar verilince anahtarlı doğrulayıcı kurulur', async () => {
    const closed = demoAgentOptions(params(), deliveries).authenticate;
    expect(await closed({ headers: { 'x-api-key': 'k'.repeat(32) } } as never)).toBeNull();
    const institution = Keypair.generate().publicKey.toBase58();
    const open = demoAgentOptions(
      params({ callers: callerGrants('k'.repeat(32), [institution]) }),
      deliveries,
    ).authenticate;
    expect(await open({ headers: { 'x-api-key': 'k'.repeat(32) } } as never)).toMatchObject({
      id: `api-key:${sha256Hex('k'.repeat(32))}`,
    });
  });
});

describe('serveDemoAgent', () => {
  function stub(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    const agent = {
      resume: vi.fn(async () => 0),
      close: vi.fn(async () => undefined),
      handle,
    } as unknown as Agent;
    const deliveries = createDeliveryStore('https://agent.example.org/demo');
    const demo: DemoAgent = {
      agent,
      deliveries,
      basePath: '/demo',
      async handle(request, response) {
        if (deliveries.handle(request, response)) return;
        await agent.handle(request, response);
      },
    };
    return { agent, deliveries, demo };
  }

  it('teslimat yolunu kendisi, geri kalanını agent-sdk işleyicisi sunar; kapanınca agent de kapanır', async () => {
    const { agent, deliveries, demo } = stub(async (_request, response) => {
      response.writeHead(418);
      response.end('agent');
    });
    const content = new TextEncoder().encode('teslimat');
    const { workHash } = await deliveries.upload({
      job: Keypair.generate().publicKey,
      content,
      contentType: 'text/plain',
    });
    const running = await serveDemoAgent(demo, { port: 0, host: '127.0.0.1' });
    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/demo$/);
      expect(agent.resume).toHaveBeenCalledTimes(1);
      const delivered = await fetch(`${running.url}/deliveries/${workHash}`);
      expect(delivered.status).toBe(200);
      expect(await delivered.text()).toBe('teslimat');
      const other = await fetch(`${running.url}/a2a`);
      expect(other.status).toBe(418);
    } finally {
      await running.close();
    }
    expect(agent.close).toHaveBeenCalledTimes(1);
  });

  it('işleyicinin hatası 500 olarak döner ve bildirilir', async () => {
    const { demo } = stub(async () => {
      throw new Error('bozuk');
    });
    const errors: unknown[] = [];
    const running = await serveDemoAgent(demo, { port: 0, host: '127.0.0.1', onError: (error) => errors.push(error) });
    try {
      const response = await fetch(`${running.url}/a2a`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'iç hata' });
      expect(errors).toHaveLength(1);
    } finally {
      await running.close();
    }
  });
});
