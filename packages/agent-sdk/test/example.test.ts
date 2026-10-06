// Örnek agent'ın işleyicisi: çıktı girdiden hesaplanır (sabit yanıt yok).
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { textStats, textStatsCapability, textStatsHandler } from '../examples/text-stats-agent.js';
import type { JobRequest } from '../src/types.js';

const job = Keypair.generate().publicKey;

function request(spec: unknown, progress: string[] = []): JobRequest {
  return {
    capability: textStatsCapability(1n),
    spec,
    job: {
      address: job,
      institution: job,
      agentRecord: job,
      agentWallet: job,
      mint: job,
      amount: 1n,
      deadline: 0,
      specHash: '00'.repeat(32),
    },
    taskId: 't',
    caller: 'c',
    message: { messageId: 'm', role: 'ROLE_USER', parts: [{ data: spec as never }] },
    signal: new AbortController().signal,
    progress: async (text) => {
      progress.push(text);
    },
  };
}

describe('örnek: text.stats', () => {
  it('farklı girdiler farklı istatistik verir', () => {
    const a = textStats('Kedi uyur. Kedi oynar!', job.toBase58());
    expect(a).toMatchObject({ words: 4, uniqueWords: 3, sentences: 2, characters: 22 });
    expect(a.topTerms[0]).toEqual({ term: 'kedi', count: 2 });
    const b = textStats('Bir iki üç dört beş altı yedi sekiz dokuz on', job.toBase58());
    expect(b).toMatchObject({ words: 10, sentences: 1, readingTimeSeconds: 3 });
    expect(b.inputSha256).not.toBe(a.inputSha256);
    expect(textStats('   ', job.toBase58())).toMatchObject({ words: 0, averageWordLength: 0, sentences: 0 });
  });

  it('işleyici JSON teslimat üretir ve ilerleme bildirir; input yoksa hata', async () => {
    const progress: string[] = [];
    const output = await textStatsHandler(request({ input: 'Merhaba dünya' }, progress));
    expect(typeof output === 'object' && output.contentType).toBe('application/json');
    const parsed = JSON.parse(String(typeof output === 'object' ? output.content : output));
    expect(parsed).toMatchObject({ words: 2, job: job.toBase58() });
    expect(progress).toEqual(['2 kelime işlendi']);
    await expect(textStatsHandler(request({ input: '' }))).rejects.toThrow('input');
    await expect(textStatsHandler(request(null))).rejects.toThrow('input');
  });
});
