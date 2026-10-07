import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Keypair } from '@solana/web3.js';
import type { Agent } from '@squaresdk/solana-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { callerGrants, serveDemoAgent, sha256Hex, type DemoAgent } from '../src/agent.js';
import { createDeliveryStore } from '../src/delivery.js';

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
