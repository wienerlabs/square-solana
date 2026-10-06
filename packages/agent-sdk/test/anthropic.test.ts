// LLM işleyicisi: istemci enjekte edilir (ağ yok); varsayılan model, istem, ret ve kesik yanıt.
import { Keypair } from '@solana/web3.js';
import type { Message as ClaudeMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { describe, expect, it } from 'vitest';
import { anthropicHandler, DEFAULT_ANTHROPIC_MODEL, type MessagesClient } from '../src/anthropic.js';
import type { JobRequest } from '../src/types.js';
import { STATS } from './helpers/harness.js';

function fakeClient(reply: Partial<ClaudeMessage>) {
  const calls: { body: MessageCreateParamsNonStreaming; signal: AbortSignal | undefined }[] = [];
  const client = {
    messages: {
      create: async (body: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }) => {
        calls.push({ body, signal: options?.signal });
        return { content: [], stop_reason: 'end_turn', ...reply };
      },
    },
  } as unknown as MessagesClient;
  return { client, calls };
}

const request = (spec: unknown): JobRequest => {
  const key = Keypair.generate().publicKey;
  return {
    capability: STATS,
    spec,
    job: {
      address: key,
      institution: key,
      agentRecord: key,
      agentWallet: key,
      mint: key,
      amount: 1n,
      deadline: 0,
      specHash: '00'.repeat(32),
    },
    taskId: 't',
    caller: 'c',
    message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'x' }] },
    signal: new AbortController().signal,
    progress: async () => undefined,
  };
};

const text = (value: string) => ({ type: 'text', text: value, citations: null }) as ClaudeMessage['content'][number];

describe('anthropicHandler', () => {
  it('varsayılan model Claude Haiku 4.5; istem spec.input; metin teslimat olur', async () => {
    const { client, calls } = fakeClient({ content: [text('özet '), text('hazır')] });
    const handler = anthropicHandler({ system: 'Özetle.', client });
    const job = request({ input: 'uzun metin' });
    const output = await handler(job);
    expect(output).toEqual({ content: 'özet hazır', contentType: 'text/markdown; charset=utf-8' });
    expect(calls[0]!.body).toEqual({
      model: DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 16_000,
      system: 'Özetle.',
      messages: [{ role: 'user', content: 'uzun metin' }],
    });
    expect(DEFAULT_ANTHROPIC_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(calls[0]!.signal).toBe(job.signal);
  });

  it('model, sınır, istem ve içerik tipi yapılandırılabilir; input yoksa spec JSON’u', async () => {
    const { client, calls } = fakeClient({ content: [text('{}')] });
    await anthropicHandler({
      system: 's',
      model: 'claude-opus-5-5',
      maxTokens: 512,
      client,
      contentType: 'application/json',
    })(request({ rows: [1, 2] }));
    expect(calls[0]!.body.model).toBe('claude-opus-5-5');
    expect(calls[0]!.body.max_tokens).toBe(512);
    expect(calls[0]!.body.messages[0]!.content).toBe('{"rows":[1,2]}');
    await anthropicHandler({ system: 's', client, prompt: (r) => `iş: ${r.capability.id}` })(request({}));
    expect(calls[1]!.body.messages[0]!.content).toBe('iş: text.stats');
  });

  it('ret, kesik yanıt ve boş metin teslim edilmez', async () => {
    const run = (reply: Partial<ClaudeMessage>) =>
      anthropicHandler({ system: 's', client: fakeClient(reply).client })(request({ input: 'x' }));
    await expect(run({ stop_reason: 'refusal', content: [text('hayır')] })).rejects.toThrow('reddetti');
    await expect(run({ stop_reason: 'max_tokens', content: [text('yar')] })).rejects.toThrow('max_tokens');
    await expect(run({ content: [] })).rejects.toThrow('metin döndürmedi');
  });

  it('geçersiz yapılandırma', () => {
    expect(() => anthropicHandler({ system: 's', model: '' })).toThrow('model');
    expect(() => anthropicHandler({ system: 's', maxTokens: 0 })).toThrow('maxTokens');
    expect(() => anthropicHandler({ system: '  ' })).toThrow('system');
  });

  it('istemci verilmezse kimlik bilgisini ortamdan okur', async () => {
    const saved = {
      key: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      base: process.env.ANTHROPIC_BASE_URL,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    // Ağa çıkılmaz: istek olursa kapalı yerel porta gider.
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    try {
      const handler = anthropicHandler({ system: 's', maxTokens: 16 });
      await expect(handler(request({ input: 'x' }))).rejects.toThrow();
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
      if (saved.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.base;
    }
  });
});
