// LLM ile iş yapan işleyici (isteğe bağlı alt yol `@squaresdk/solana-agent-sdk/anthropic`). Kaynak: aip-beta
// `packages/agent-sdk/src/haiku.ts` @ 5a36fe0 (MIT, LICENSE-MIT). Farkları: `@anthropic-ai/sdk` isteğe bağlı
// peer bağımlılıktır (çekirdek LLM'e bağlı değildir); model yapılandırılabilir, varsayılanı Claude Haiku 4.5;
// kimlik bilgisi yalnızca ortamdan (`ANTHROPIC_API_KEY`) okunur; ret ve kesik yanıt teslim edilmez.
// SDK yalnızca istemci verilmediğinde ve ilk çağrıda yüklenir: alt yol, paket kurulu olmadan da içe aktarılır.
import type Anthropic from '@anthropic-ai/sdk';
import type { JobHandler, JobRequest } from './types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
/** Akışsız istek için güvenli üst sınır. */
export const DEFAULT_MAX_TOKENS = 16_000;

/** Testlerde ve özel istemcilerde kullanılan `messages.create` yüzeyi. */
export type MessagesClient = Pick<Anthropic, 'messages'>;

export interface AnthropicHandlerOptions {
  /** Sistem talimatı. */
  system: string;
  model?: string;
  maxTokens?: number;
  /** İşten kullanıcı mesajı; verilmezse spec'in `input` metni, yoksa spec'in JSON'u. */
  prompt?: (request: JobRequest) => string;
  /** Teslimatın içerik tipi; varsayılan `text/markdown; charset=utf-8`. */
  contentType?: string;
  /**
   * İstemci; verilmezse ilk çağrıda `new Anthropic()` kurulur ve kimlik bilgisini ortamdan okur. Anahtar
   * koda ya da yapılandırma dosyasına yazılmaz.
   */
  client?: MessagesClient;
}

function defaultPrompt(request: JobRequest): string {
  const { spec } = request;
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    const input = (spec as Record<string, unknown>).input;
    if (typeof input === 'string' && input.trim().length > 0) return input;
  }
  return JSON.stringify(spec);
}

export function anthropicHandler(options: AnthropicHandlerOptions): JobHandler {
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!model) throw new Error('anthropicHandler: model boş olamaz');
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('anthropicHandler: maxTokens pozitif tamsayı olmalı');
  }
  if (!options.system.trim()) throw new Error('anthropicHandler: system boş olamaz');
  const prompt = options.prompt ?? defaultPrompt;
  const contentType = options.contentType ?? 'text/markdown; charset=utf-8';
  let client = options.client ?? null;

  return async (request) => {
    client ??= new (await import('@anthropic-ai/sdk')).default();
    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: options.system,
        messages: [{ role: 'user', content: prompt(request) }],
      },
      { signal: request.signal },
    );
    if (response.stop_reason === 'refusal') {
      throw new Error(`anthropicHandler: model ${model} isteği reddetti`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error(`anthropicHandler: yanıt max_tokens (${maxTokens}) sınırında kesildi; kesik iş teslim edilmez`);
    }
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    if (!text) {
      throw new Error(`anthropicHandler: model ${model} metin döndürmedi (stop_reason=${response.stop_reason})`);
    }
    return { content: text, contentType };
  };
}
