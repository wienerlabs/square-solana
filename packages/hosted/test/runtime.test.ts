// Çalışma zamanı izolasyonu: capability başına havuz ve allowlist, zaman sınırı, eşzamanlılık sınırı ve kuyruk,
// iptal ve hata yalıtımı (bir capability'nin hatası diğerini durdurmaz).
import type { JobRequest } from '@squaresdk/solana-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHostedConfig, type CapabilityConfig } from '../src/config.js';
import { CapabilityBusyError, CapabilityRuntime, CapabilityTimeoutError } from '../src/runtime.js';
import { fakeClaude, lastToolResults, text, toolUse, type Scenario, toolNames } from './helpers/claude.js';
import { LIMITS, rawConfig } from './helpers/config.js';
import { toolServer } from './helpers/mcp.js';

const runtimes: CapabilityRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function capability(overrides: Record<string, unknown> = {}): CapabilityConfig {
  const base = (rawConfig().capabilities as Record<string, unknown>[])[0]!;
  return parseHostedConfig(rawConfig({ capabilities: [{ ...base, ...overrides }] })).capabilities[0]!;
}

function request(spec: unknown, signal = new AbortController().signal): JobRequest {
  return { spec, signal, capability: { id: 'x' } } as unknown as JobRequest;
}

function runtime(scenario: Scenario, overrides: Record<string, unknown> = {}, server = toolServer()) {
  const fake = fakeClaude(scenario);
  const config = capability(overrides);
  const item = new CapabilityRuntime({
    capability: config,
    pool: config.tools.length ? server.pool() : null,
    client: fake.client,
  });
  runtimes.push(item);
  return { runtime: item, fake, server };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('CapabilityRuntime', () => {
  it("işi izinli MCP tool'uyla yürütür; çıktı capability'nin içerik tipiyle döner", async () => {
    const {
      runtime: item,
      fake,
      server,
    } = runtime(
      (params, call) =>
        call === 1
          ? toolUse([
              { name: 'tools__echo', input: { text: 'selam' } },
              { name: 'tools__secret_read', input: { key: 'anahtar' } },
            ])
          : text(
              lastToolResults(params)
                .map((r) => r.content)
                .join(' | '),
            ),
      { contentType: 'text/plain; charset=utf-8' },
    );
    const output = await item.run(request({ input: 'selam de' }));
    expect(output).toEqual({
      content: 'echo: selam | tool tools__secret_read is not allowed for this capability',
      contentType: 'text/plain; charset=utf-8',
    });
    // Claude yalnızca allowlist'i gördü; sunucuya yalnızca izinli çağrı ulaştı.
    expect(toolNames(fake.requests[0]!)).toEqual(['tools__echo']);
    expect(fake.requests[0]!.messages[0]).toEqual({ role: 'user', content: 'selam de' });
    expect(server.calls).toEqual([{ tool: 'echo', args: { text: 'selam' } }]);
    expect(item.stats()).toMatchObject({ completed: 1, failed: 0, deniedToolCalls: 1, active: 0 });
  });

  it("spec'te input yoksa spec'in JSON'u istem olur", async () => {
    const { runtime: item, fake } = runtime(() => text('ok'), { tools: [] });
    await item.run(request({ capability: 'x', n: 1 }));
    expect(fake.requests[0]!.messages[0]!.content).toBe('{"capability":"x","n":1}');
  });

  it('zaman sınırı: yavaş tool çalıştırmayı keser, sebep zaman aşımı', async () => {
    const { runtime: item } = runtime(() => toolUse([{ name: 'tools__slow', input: { ms: 2_000 } }]), {
      tools: [{ server: 'tools', allow: ['slow'] }],
      limits: { ...LIMITS, timeoutMs: 150 },
    });
    const started = Date.now();
    await expect(item.run(request({ input: 'yavaş' }))).rejects.toBeInstanceOf(CapabilityTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(item.stats()).toMatchObject({ failed: 1, active: 0 });
  });

  it('eşzamanlılık sınırı ve kuyruk: fazlası bekler, kuyruk doluysa yeni iş kabulden önce reddedilir', async () => {
    const gate = deferred();
    let concurrent = 0;
    let peak = 0;
    const { runtime: item } = runtime(
      async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await gate.promise;
        concurrent -= 1;
        return text('tamam');
      },
      { tools: [], limits: { ...LIMITS, maxConcurrency: 2, maxQueue: 1 } },
    );
    const runs = [
      item.run(request({ input: '1' })),
      item.run(request({ input: '2' })),
      item.run(request({ input: '3' })),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(item.stats()).toMatchObject({ active: 2, queued: 1 });
    expect(item.room()).toMatch(/eşzamanlılık sınırı \(2\) ve kuyruk \(1\) dolu/);
    const admitted = item.run(request({ input: '4' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(item.stats()).toMatchObject({ active: 2, queued: 2 });
    gate.resolve();
    expect((await Promise.all([...runs, admitted])).map((r) => r.content)).toEqual([
      'tamam',
      'tamam',
      'tamam',
      'tamam',
    ]);
    expect(peak).toBe(2);
    expect(item.room()).toBeNull();
    expect(item.stats()).toMatchObject({ active: 0, queued: 0, completed: 4, rejected: 1 });
  });

  it('kuyrukta iptal edilen iş slot almadan düşer; kapatma kuyruğu reddeder', async () => {
    const gate = deferred();
    const { runtime: item } = runtime(async () => (await gate.promise, text('ok')), {
      tools: [],
      limits: { ...LIMITS, maxConcurrency: 1, maxQueue: 2 },
    });
    const first = item.run(request({ input: '1' }));
    const controller = new AbortController();
    const second = item.run(request({ input: '2' }, controller.signal));
    const third = item.run(request({ input: '3' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('görev iptal'));
    await expect(second).rejects.toThrow('görev iptal');
    expect(item.stats().queued).toBe(1);
    const closing = item.close();
    await expect(third).rejects.toBeInstanceOf(CapabilityBusyError);
    gate.resolve();
    await first;
    await closing;
    await expect(item.run(request({ input: '4' }))).rejects.toThrow(/kapatıldı/);
    const aborted = new AbortController();
    aborted.abort(new Error('önceden'));
    const { runtime: other } = runtime(() => text('x'), { tools: [] });
    await expect(other.run(request({}, aborted.signal))).rejects.toThrow('önceden');
  });

  it('hata yalıtımı: bir capability çökerken diğeri çalışmaya devam eder', async () => {
    const broken = runtime(
      () => {
        throw new Error('model erişilemez');
      },
      { id: 'kirik', tools: [] },
    );
    const missingTool = runtime(() => text('x'), { id: 'eksik', tools: [{ server: 'tools', allow: ['yok'] }] });
    const healthy = runtime(() => text('sağlam'), { id: 'saglam', tools: [] });
    const results = await Promise.allSettled([
      broken.runtime.run(request({ input: 'a' })),
      missingTool.runtime.run(request({ input: 'b' })),
      healthy.runtime.run(request({ input: 'c' })),
      broken.runtime.run(request({ input: 'd' })),
      healthy.runtime.run(request({ input: 'e' })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled', 'rejected', 'fulfilled']);
    expect(broken.runtime.stats()).toMatchObject({ failed: 2, active: 0 });
    expect(missingTool.runtime.stats()).toMatchObject({ failed: 1 });
    expect(healthy.runtime.stats()).toMatchObject({ completed: 2, failed: 0 });
    expect(missingTool.fake.requests).toHaveLength(0);
  });
});
