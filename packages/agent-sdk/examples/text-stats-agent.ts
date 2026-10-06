// Örnek agent: job spec'indeki metnin istatistiklerini (kelime, cümle, tekil kelime, sık terimler, okuma süresi)
// JSON olarak teslim eder; `ANTHROPIC_API_KEY` ortamdaysa `text.summarize` becerisini de sunar (Claude ile
// özet). Çıktı tamamen girdiden hesaplanır. Çalıştırma ve ortam değişkenleri: packages/agent-sdk/README.md.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createPrismaTaskStore } from '@squaresdk/solana-a2a/prisma';
import { createDatabaseClient } from '@squaresdk/solana-db';
import type { SquareProgramIds } from '@squaresdk/solana-sdk';
import { anthropicHandler } from '../src/anthropic.js';
import {
  createAgent,
  createApiKeyAuthenticator,
  type AgentCapability,
  type ApiKeyGrant,
  type Deliverable,
  type JobHandler,
  type JobRequest,
} from '../src/index.js';

export const TEXT_STATS_ID = 'text.stats';
export const TEXT_SUMMARIZE_ID = 'text.summarize';

/** Dakikada okunan ortalama kelime (yetişkin sessiz okuma). */
const WORDS_PER_MINUTE = 238;

export function textStatsCapability(price: bigint): AgentCapability {
  return {
    id: TEXT_STATS_ID,
    name: 'Metin istatistikleri',
    description: 'Metnin kelime, cümle ve tekil kelime sayılarını, sık terimlerini ve okuma süresini hesaplar.',
    tags: ['text', 'analysis', 'statistics'],
    examples: ['{"capability":"text.stats","input":"Analiz edilecek metin"}'],
    price,
  };
}

function inputOf(request: JobRequest): string {
  const spec = request.spec as { input?: unknown } | null;
  if (!spec || typeof spec.input !== 'string' || spec.input.trim().length === 0) {
    throw new Error('job spec’i boş olmayan bir input metni taşımalı');
  }
  return spec.input;
}

export interface TextStats {
  capability: string;
  job: string;
  words: number;
  uniqueWords: number;
  sentences: number;
  characters: number;
  averageWordLength: number;
  readingTimeSeconds: number;
  topTerms: { term: string; count: number }[];
  inputSha256: string;
}

export function textStats(input: string, job: string): TextStats {
  const words = input.toLocaleLowerCase('tr').match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const topTerms = [...counts.entries()]
    .filter(([term]) => [...term].length >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'))
    .slice(0, 10)
    .map(([term, count]) => ({ term, count }));
  const letters = words.reduce((sum, word) => sum + [...word].length, 0);
  return {
    capability: TEXT_STATS_ID,
    job,
    words: words.length,
    uniqueWords: counts.size,
    sentences: input.split(/[.!?…]+/u).filter((part) => /[\p{L}\p{N}]/u.test(part)).length,
    characters: [...input].length,
    averageWordLength: words.length === 0 ? 0 : Math.round((letters / words.length) * 100) / 100,
    readingTimeSeconds: Math.ceil((words.length / WORDS_PER_MINUTE) * 60),
    topTerms,
    inputSha256: createHash('sha256').update(input, 'utf8').digest('hex'),
  };
}

export const textStatsHandler: JobHandler = async (request): Promise<Deliverable> => {
  const stats = textStats(inputOf(request), request.job.address.toBase58());
  await request.progress(`${stats.words} kelime işlendi`);
  return { content: JSON.stringify(stats), contentType: 'application/json' };
};

// ---------------------------------------------------------------- çalıştırma

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} ortam değişkeni gerekli`);
  return value;
}

function atomic(name: string): bigint {
  const value = env(name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} pozitif tamsayı (mint'in atomik birimi) olmalı`);
  return BigInt(value);
}

function programIds(): SquareProgramIds {
  return {
    registry: new PublicKey(env('SQUARE_PROGRAM_ID_REGISTRY')),
    policy: new PublicKey(env('SQUARE_PROGRAM_ID_POLICY')),
    verifier: new PublicKey(env('SQUARE_PROGRAM_ID_VERIFIER')),
    escrow: new PublicKey(env('SQUARE_PROGRAM_ID_ESCROW')),
  };
}

const log = {
  info: (message: string) => process.stdout.write(`${message}\n`),
  error: (message: string) => process.stderr.write(`${message}\n`),
};

async function main(): Promise<void> {
  const signer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(env('AGENT_KEYPAIR'), 'utf8')) as number[]),
  );
  const capabilities = [textStatsCapability(atomic('AGENT_PRICE_TEXT_STATS'))];
  const summarize = process.env.ANTHROPIC_API_KEY
    ? anthropicHandler({
        system: 'Sen bir özetleme uzmanısın. Verilen metni 200 kelimeyi geçmeyen, Markdown biçimli bir özetle yanıtla.',
        ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
      })
    : null;
  if (summarize) {
    capabilities.push({
      id: TEXT_SUMMARIZE_ID,
      name: 'Metin özeti',
      description: 'Metni Claude ile 200 kelimenin altında özetler.',
      tags: ['text', 'summarization', 'llm'],
      price: atomic('AGENT_PRICE_TEXT_SUMMARIZE'),
    });
  }
  const db = createDatabaseClient({ connectionString: env('DATABASE_URL') });
  const discount = process.env.AGENT_AUTO_LIST_CLAIM_BPS;
  const agent = await createAgent({
    name: 'Metin Ajanı',
    description: 'Metin istatistikleri ve (anahtar varsa) Claude ile özet üreten örnek Square agent’ı.',
    version: '1.0.0',
    publicUrl: env('AGENT_PUBLIC_URL'),
    agentId: env('AGENT_ID'),
    capabilities,
    handler: async (request) =>
      request.capability.id === TEXT_SUMMARIZE_ID && summarize ? summarize(request) : textStatsHandler(request),
    signer,
    connection: new Connection(env('AGENT_RPC_URL'), 'confirmed'),
    programIds: programIds(),
    api: { baseUrl: env('AGENT_API_BASE_URL'), apiKey: env('AGENT_API_KEY') },
    store: createPrismaTaskStore(db),
    authenticate: createApiKeyAuthenticator({ keys: JSON.parse(env('AGENT_CALLER_KEYS')) as ApiKeyGrant[] }),
    ...(discount ? { autoListClaim: { discountBps: Number(discount) } } : {}),
    logger: log,
  });
  const hosting = process.env.AGENT_REGISTER;
  if (hosting === 'self' || hosting === 'api') {
    const registration = await agent.register({ hosting });
    log.info(`kayıt ${registration.status}: ${registration.agentRecord.toBase58()} → ${registration.agentCardUri}`);
  }
  const server = await agent.listen({ port: Number(env('AGENT_PORT')), host: process.env.AGENT_HOST ?? '0.0.0.0' });
  const stop = () => {
    void agent.close().then(() => db.$disconnect());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('close', () => log.info('agent kapandı'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}
