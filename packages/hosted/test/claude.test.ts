// Claude tool döngüsü (sahte Messages istemcisi) ve MCP ↔ Claude tool dönüşümü: yalnızca allowlist'teki tool'lar
// Claude'a gösterilir, liste dışı ad sunucuya gitmez, sınırlar (tur, token, max_tokens) ve ret uygulanır.
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityRunError, runClaude, type ClaudeRunOptions } from '../src/claude.js';
import {
  ToolAllowlistError,
  claudeToolName,
  mcpResultToOutcome,
  resolveMcpTools,
  type LocalTool,
} from '../src/tools.js';
import { fakeClaude, lastToolResults, message, text, toolUse, toolNames } from './helpers/claude.js';
import { toolServer } from './helpers/mcp.js';

const pools: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

const base = (overrides: Partial<ClaudeRunOptions>): ClaudeRunOptions => ({
  client: fakeClaude(() => text('ok')).client,
  model: 'claude-opus-5-5',
  system: 'sistem',
  prompt: 'girdi',
  tools: [],
  maxTokens: 1_000,
  maxTurns: 5,
  maxTotalTokens: 10_000,
  signal: new AbortController().signal,
  ...overrides,
});

const localTool = (name: string, call: LocalTool['call']): LocalTool => ({
  definition: { name, description: name, input_schema: { type: 'object', properties: {} } },
  call,
});

describe('runClaude', () => {
  it('tool_use → tool sonucu → metin; sistem, model, effort ve tool tanımları isteğe gider', async () => {
    const fake = fakeClaude((params, call) =>
      call === 1
        ? toolUse([{ name: 'tools__echo', input: { text: 'merhaba' } }])
        : text(`son: ${lastToolResults(params)[0]!.content as string}`),
    );
    const echo = localTool('tools__echo', async (input) => ({
      content: `echo: ${input.text as string}`,
      isError: false,
    }));
    const result = await runClaude(base({ client: fake.client, tools: [echo], effort: 'low', system: 'talimat' }));
    expect(result).toMatchObject({ text: 'son: echo: merhaba', turns: 2, totalTokens: 30 });
    expect(result.toolCalls).toEqual([{ name: 'tools__echo', outcome: 'ok' }]);
    expect(fake.requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1_000,
      system: 'talimat',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'girdi' }],
    });
    expect(toolNames(fake.requests[0]!)).toEqual(['tools__echo']);
    // İkinci istek asistanın tool_use'unu ve sonucu taşır.
    expect(fake.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it("tool'suz capability tools alanı göndermez", async () => {
    const fake = fakeClaude(() => text('yalnız metin'));
    await runClaude(base({ client: fake.client }));
    expect(fake.requests[0]).not.toHaveProperty('tools');
    expect(fake.requests[0]).not.toHaveProperty('output_config');
  });

  it('allowlist dışı ad yürütülmez: is_error sonucu döner ve denied sayılır', async () => {
    let called = false;
    const fake = fakeClaude((params, call) =>
      call === 1
        ? toolUse([{ name: 'tools__secret_read', input: { key: 'k' } }])
        : text(JSON.stringify(lastToolResults(params))),
    );
    const echo = localTool('tools__echo', async () => ((called = true), { content: 'x', isError: false }));
    const records: string[] = [];
    const result = await runClaude(
      base({ client: fake.client, tools: [echo], onToolCall: (call) => records.push(`${call.name}:${call.outcome}`) }),
    );
    expect(called).toBe(false);
    expect(records).toEqual(['tools__secret_read:denied']);
    expect(JSON.parse(result.text)).toEqual([
      expect.objectContaining({
        is_error: true,
        content: 'tool tools__secret_read is not allowed for this capability',
      }),
    ]);
  });

  it('paralel çağrılar tek kullanıcı mesajında döner; hata ve bozuk girdi is_error', async () => {
    const fake = fakeClaude((params, call) =>
      call === 1
        ? toolUse([
            { name: 'a', input: {} },
            { name: 'b', input: {} },
            { name: 'a', input: 'dize' },
          ])
        : text(String(lastToolResults(params).length)),
    );
    const a = localTool('a', async () => ({ content: 'A', isError: false }));
    const b = localTool('b', async () => {
      throw new Error('çöktü');
    });
    const result = await runClaude(base({ client: fake.client, tools: [a, b] }));
    expect(result.text).toBe('3');
    const results = lastToolResults(fake.requests[1]!);
    expect(results.map((r) => [r.content, r.is_error ?? false])).toEqual([
      ['A', false],
      ['tool call failed: çöktü', true],
      ['tool input must be a JSON object', true],
    ]);
    // Kayıt bitiş sırasıyla; sonuçlar ise çağrı sırasıyla döner.
    expect(result.toolCalls.map((c) => c.outcome).sort()).toEqual(['error', 'error', 'ok']);
  });

  it('pause_turn yanıtı eklenip yeniden gönderilir', async () => {
    const fake = fakeClaude((_params, call) => (call === 1 ? message([], 'pause_turn') : text('bitti')));
    const result = await runClaude(base({ client: fake.client }));
    expect(result).toMatchObject({ text: 'bitti', turns: 2 });
    expect(fake.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('sınırlar ve teslim edilemeyen yanıtlar', async () => {
    const loop = localTool('loop', async () => ({ content: 'tekrar', isError: false }));
    const forever = fakeClaude(() => toolUse([{ name: 'loop', input: {} }]));
    await expect(runClaude(base({ client: forever.client, tools: [loop], maxTurns: 3 }))).rejects.toMatchObject({
      reason: 'maxTurns',
    });
    expect(forever.requests).toHaveLength(3);

    const heavy = fakeClaude(() => toolUse([{ name: 'loop', input: {} }], { input: 600, output: 100 }));
    const error = await runClaude(base({ client: heavy.client, tools: [loop], maxTotalTokens: 1_000 })).catch((e) => e);
    expect(error).toBeInstanceOf(CapabilityRunError);
    expect(error).toMatchObject({ reason: 'maxTotalTokens' });
    expect(heavy.requests).toHaveLength(2);

    const cases: [ReturnType<typeof message>, string][] = [
      [message([], 'refusal'), 'refusal'],
      [message([{ type: 'text', text: 'yarım', citations: null }], 'max_tokens'), 'maxTokens'],
      [message([], 'model_context_window_exceeded'), 'contextWindow'],
      [text('   '), 'emptyResponse'],
    ];
    for (const [response, reason] of cases) {
      await expect(runClaude(base({ client: fakeClaude(() => response).client }))).rejects.toMatchObject({ reason });
    }
  });

  it('iptal edilen çalıştırma tool hatası değil, çalıştırmanın hatasıdır', async () => {
    const controller = new AbortController();
    const fake = fakeClaude(() => toolUse([{ name: 'stop', input: {} }]));
    const stop = localTool('stop', async () => {
      controller.abort(new Error('iptal'));
      throw new Error('kesildi');
    });
    await expect(runClaude(base({ client: fake.client, tools: [stop], signal: controller.signal }))).rejects.toThrow(
      'iptal',
    );
  });
});

describe('MCP tool dönüşümü', () => {
  it("allowlist'teki tool'lar sunucu önekli adla ve sunucunun şemasıyla; diğerleri dönmez", async () => {
    const server = toolServer();
    const pool = server.pool();
    pools.push(pool);
    const tools = await resolveMcpTools(pool, [{ server: 'tools', allow: ['echo'] }], { maxResultBytes: 1_000 });
    expect(tools.map((tool) => tool.definition.name)).toEqual(['tools__echo']);
    expect(tools[0]!.definition.description).toBe('Echo the text.');
    expect(tools[0]!.definition.input_schema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
    expect(await tools[0]!.call({ text: 'a' }, new AbortController().signal)).toEqual({
      content: 'echo: a',
      isError: false,
    });
    expect(server.calls).toEqual([{ tool: 'echo', args: { text: 'a' } }]);
  });

  it('sunucunun sunmadığı tool ve Claude adına uymayan tool açılışta reddedilir', async () => {
    const pool = toolServer().pool();
    pools.push(pool);
    await expect(resolveMcpTools(pool, [{ server: 'tools', allow: ['yok'] }], { maxResultBytes: 1 })).rejects.toThrow(
      ToolAllowlistError,
    );
    await expect(
      resolveMcpTools(pool, [{ server: 'tools', allow: ['dotted.name'] }], { maxResultBytes: 1 }),
    ).rejects.toThrow(/Claude'a verilemez/);
    expect(() => claudeToolName('s', 'x'.repeat(70))).toThrow(ToolAllowlistError);
  });

  it('büyük sonuç kesilmez, hata olarak döner; sunucu hatası is_error', async () => {
    const pool = toolServer({ bigBytes: 2_000 }).pool();
    pools.push(pool);
    const [big, fails] = await resolveMcpTools(pool, [{ server: 'tools', allow: ['big', 'fails'] }], {
      maxResultBytes: 1_000,
    });
    expect(await big!.call({}, new AbortController().signal)).toEqual({
      content: 'tool result is too large (2000 bytes, limit 1000); narrow the request',
      isError: true,
    });
    expect(await fails!.call({}, new AbortController().signal)).toEqual({ content: 'upstream down', isError: true });
  });

  it('MCP içerik blokları metne çevrilir', () => {
    expect(
      mcpResultToOutcome(
        {
          content: [
            { type: 'text', text: 'a' },
            { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
            { type: 'resource', resource: { uri: 'file:///x', text: 'kaynak' } },
            { type: 'resource', resource: { uri: 'file:///y', blob: 'AA==' } },
            { type: 'resource_link', uri: 'file:///z', name: 'z' },
          ],
        },
        1_000,
      ),
    ).toEqual({
      content: 'a\n[image image/png, 3 bayt]\nkaynak\n[resource file:///y]\n[resource_link file:///z]',
      isError: false,
    });
    expect(mcpResultToOutcome({ content: [], structuredContent: { n: 1 } }, 100)).toEqual({
      content: '{"n":1}',
      isError: false,
    });
  });
});
