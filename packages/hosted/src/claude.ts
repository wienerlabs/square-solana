// Capability'nin Claude çalıştırması: Messages API'siyle elle yürütülen tool döngüsü. Tool runner yerine elle döngü
// seçildi; her tool çağrısında allowlist denetimi ve her yanıtta token sayımı bu döngüde yapılır. Claude'a yalnızca
// verilen tool'lar gösterilir; listede olmayan bir adla gelen çağrı yürütülmez, `is_error` sonucuyla döner. Sınırlar:
// istek sayısı (`maxTurns`), toplam token (`maxTotalTokens`), yanıt başına `max_tokens` ve çağıranın sinyali (zaman
// sınırı runtime.ts'te). Ret, kesik ya da metinsiz yanıt teslim edilmez.
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from '@squaresdk/solana-agent-sdk/anthropic';
import type { LocalTool } from './tools.js';

export type { MessagesClient };

/** Çalıştırma bir sınıra takıldı ya da Claude teslim edilemez bir yanıt verdi. */
export class CapabilityRunError extends Error {
  constructor(
    readonly reason: 'maxTurns' | 'maxTotalTokens' | 'refusal' | 'maxTokens' | 'contextWindow' | 'emptyResponse',
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityRunError';
  }
}

export interface ClaudeRunOptions {
  client: MessagesClient;
  model: string;
  system: string;
  effort?: Anthropic.OutputConfig['effort'];
  prompt: string;
  tools: readonly LocalTool[];
  maxTokens: number;
  maxTurns: number;
  maxTotalTokens: number;
  signal: AbortSignal;
  /** Her tool çağrısından sonra (izleme ve testler). */
  onToolCall?: (call: ToolCallRecord) => void;
}

export interface ToolCallRecord {
  name: string;
  /** `denied`: allowlist dışı ad, sunucuya gitmedi. */
  outcome: 'ok' | 'error' | 'denied';
}

export interface ClaudeRunResult {
  text: string;
  turns: number;
  /** Bütün isteklerin girdi (önbellek dahil) + çıktı token toplamı. */
  totalTokens: number;
  toolCalls: ToolCallRecord[];
}

const usageTokens = (usage: Anthropic.Usage) =>
  usage.input_tokens +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) +
  usage.output_tokens;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const byName = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const definitions = options.tools.map((tool) => tool.definition);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: options.prompt }];
  const toolCalls: ToolCallRecord[] = [];
  let totalTokens = 0;

  const execute = async (block: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> => {
    const tool = byName.get(block.name);
    const result = (content: string, isError: boolean, outcome: ToolCallRecord['outcome']) => {
      const record = { name: block.name, outcome };
      toolCalls.push(record);
      options.onToolCall?.(record);
      return { type: 'tool_result' as const, tool_use_id: block.id, content, ...(isError && { is_error: true }) };
    };
    if (!tool) return result(`tool ${block.name} is not allowed for this capability`, true, 'denied');
    const input = block.input;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return result('tool input must be a JSON object', true, 'error');
    }
    try {
      const outcome = await tool.call(input as Record<string, unknown>, options.signal);
      return result(outcome.content, outcome.isError, outcome.isError ? 'error' : 'ok');
    } catch (error) {
      // Çalıştırma iptal edildiyse tool hatası değil, çalıştırmanın kendisi düşer.
      options.signal.throwIfAborted();
      return result(`tool call failed: ${message(error)}`, true, 'error');
    }
  };

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    options.signal.throwIfAborted();
    const response = await options.client.messages.create(
      {
        model: options.model,
        max_tokens: options.maxTokens,
        system: options.system,
        messages,
        ...(definitions.length > 0 && { tools: definitions }),
        ...(options.effort && { output_config: { effort: options.effort } }),
      },
      { signal: options.signal },
    );
    totalTokens += usageTokens(response.usage);
    if (totalTokens > options.maxTotalTokens) {
      throw new CapabilityRunError(
        'maxTotalTokens',
        `token sınırı aşıldı: ${totalTokens} > ${options.maxTotalTokens} (${turn}. istek)`,
      );
    }
    switch (response.stop_reason) {
      case 'refusal':
        throw new CapabilityRunError('refusal', `model ${options.model} isteği reddetti`);
      case 'max_tokens':
        throw new CapabilityRunError(
          'maxTokens',
          `yanıt max_tokens (${options.maxTokens}) sınırında kesildi; kesik iş teslim edilmez`,
        );
      case 'model_context_window_exceeded':
        throw new CapabilityRunError('contextWindow', `model ${options.model} bağlam penceresi doldu`);
      case 'pause_turn':
        // Sunucu tarafı uzun tur: yanıt aynen eklenip yeniden gönderilir.
        messages.push({ role: 'assistant', content: response.content });
        continue;
      case 'tool_use': {
        messages.push({ role: 'assistant', content: response.content });
        const uses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
        // Paralel çağrılar birlikte yürütülür; bütün sonuçlar tek kullanıcı mesajında döner.
        messages.push({ role: 'user', content: await Promise.all(uses.map(execute)) });
        continue;
      }
      default: {
        const text = response.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('')
          .trim();
        if (!text) {
          throw new CapabilityRunError(
            'emptyResponse',
            `model ${options.model} metin döndürmedi (stop_reason=${response.stop_reason})`,
          );
        }
        return { text, turns: turn, totalTokens, toolCalls };
      }
    }
  }
  throw new CapabilityRunError('maxTurns', `${options.maxTurns} istekte bitmedi`);
}
