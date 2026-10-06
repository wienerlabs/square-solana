// Test fixture: Messages API'sinin sahte istemcisi. Gerçek Claude API'si çağrılmaz; her istek kaydedilir ve senaryo
// fonksiyonu gelen isteğe (sistem talimatı, görünen tool'lar, önceki tool sonuçları) göre yanıtı üretir.
import type Anthropic from '@anthropic-ai/sdk';
import type { MessagesClient } from '../../src/claude.js';

export type Scenario = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  call: number,
) => Anthropic.Message | Promise<Anthropic.Message>;

export interface FakeClaude {
  client: MessagesClient;
  requests: Anthropic.MessageCreateParamsNonStreaming[];
}

let ids = 0;

export function message(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
  usage: { input?: number; output?: number } = {},
): Anthropic.Message {
  return {
    id: `msg_${(ids += 1)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input ?? 10,
      output_tokens: usage.output ?? 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as unknown as Anthropic.Message;
}

export const text = (value: string, usage?: { input?: number; output?: number }) =>
  message([{ type: 'text', text: value, citations: null } as Anthropic.TextBlock], 'end_turn', usage);

export const toolUse = (calls: { name: string; input: unknown }[], usage?: { input?: number; output?: number }) =>
  message(
    calls.map(
      (call, i) =>
        ({ type: 'tool_use', id: `toolu_${ids}_${i}`, name: call.name, input: call.input }) as Anthropic.ToolUseBlock,
    ),
    'tool_use',
    usage,
  );

/** Son kullanıcı mesajındaki tool sonuçları. */
export function lastToolResults(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.ToolResultBlockParam[] {
  const last = params.messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.content === 'string') return [];
  return last.content.filter((block): block is Anthropic.ToolResultBlockParam => block.type === 'tool_result');
}

export function fakeClaude(scenario: Scenario): FakeClaude {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }) => {
        options?.signal?.throwIfAborted();
        // Mesaj dizisi döngüde büyür; kayıt istek anındaki hâlidir.
        requests.push({ ...params, messages: [...params.messages] });
        return scenario(params, requests.length);
      },
    },
  } as unknown as MessagesClient;
  return { client, requests };
}

/** İstekte Claude'a gösterilen tool adları. */
export const toolNames = (params: Anthropic.MessageCreateParamsNonStreaming): string[] =>
  (params.tools ?? []).map((tool) => ('name' in tool ? tool.name : tool.type));
