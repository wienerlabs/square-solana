// MCP tool'ları ↔ Claude tool'ları. Capability'nin allowlist'indeki her tool, sunucunun bildirdiği şemayla Claude'a
// `${sunucu}__${tool}` adıyla verilir (iki sunucuda aynı adlı tool çakışmaz). Allowlist iki yerde uygulanır: liste
// dışındaki tool Claude'a hiç gösterilmez ve Claude yine de adını uydurursa çağrı MCP sunucusuna gitmeden hata
// sonucu olarak döner (claude.ts). Tool sonucu MCP içerik bloklarından metne çevrilir ve boyutu sınırlıdır.
import type Anthropic from '@anthropic-ai/sdk';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpClientPool } from '@squaresdk/solana-mcp/client';
import type { ToolGrant } from './config.js';

/** Claude'un kabul ettiği tool adı. */
export const CLAUDE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Allowlist'teki tool sunucuda yok ya da adı Claude'a verilemiyor. */
export class ToolAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolAllowlistError';
  }
}

/** Claude'a verilen bir tool ve onu yürüten fonksiyon. */
export interface LocalTool {
  definition: Anthropic.Tool;
  /** Sonucu metin olarak döner; `isError` Claude'a `is_error` olarak gider. */
  call(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export const claudeToolName = (server: string, tool: string): string => {
  const name = `${server}__${tool}`;
  if (!CLAUDE_TOOL_NAME.test(name)) {
    throw new ToolAllowlistError(
      `${server} sunucusunun ${tool} tool'u Claude'a verilemez: ad ${CLAUDE_TOOL_NAME} değil`,
    );
  }
  return name;
};

/** MCP tool tanımı → Claude tool tanımı (girdi şeması aynen JSON Schema'dır). */
export function toClaudeTool(name: string, tool: Tool): Anthropic.Tool {
  return {
    name,
    description: tool.description ?? tool.title ?? tool.name,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * MCP tool sonucu → Claude'a giden metin. Metin blokları aynen, diğer bloklar (görsel, kaynak) türü ve
 * boyutuyla özetlenir; yapılandırılmış içerik varsa JSON olarak eklenir. Sonuç `maxBytes`'ı aşarsa kesilmez,
 * Claude'a sınırı bildiren bir hata döner.
 */
export function mcpResultToOutcome(result: CallToolResult, maxBytes: number): ToolOutcome {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image' || block.type === 'audio') {
      parts.push(`[${block.type} ${block.mimeType}, ${Buffer.byteLength(block.data, 'base64')} bayt]`);
    } else if (block.type === 'resource') {
      const resource = block.resource;
      parts.push('text' in resource ? resource.text : `[resource ${resource.uri}]`);
    } else {
      parts.push(`[${block.type} ${block.uri}]`);
    }
  }
  if (result.structuredContent && parts.length === 0) parts.push(JSON.stringify(result.structuredContent));
  const content = parts.join('\n');
  const size = utf8Bytes(content);
  if (size > maxBytes) {
    return {
      content: `tool result is too large (${size} bytes, limit ${maxBytes}); narrow the request`,
      isError: true,
    };
  }
  return { content, isError: result.isError === true };
}

/**
 * Capability'nin allowlist'ini havuzdaki sunuculara karşı çözer. Allowlist'teki her tool sunucuda bulunmalıdır;
 * sunucunun diğer tool'ları dönmez.
 */
export async function resolveMcpTools(
  pool: McpClientPool,
  grants: readonly ToolGrant[],
  options: { maxResultBytes: number; timeoutMs?: number },
): Promise<LocalTool[]> {
  const tools: LocalTool[] = [];
  for (const grant of grants) {
    const offered = new Map((await pool.listTools(grant.server)).map((tool) => [tool.name, tool]));
    for (const name of grant.allow) {
      const tool = offered.get(name);
      if (!tool) throw new ToolAllowlistError(`${grant.server} sunucusu ${name} tool'unu sunmuyor`);
      tools.push({
        definition: toClaudeTool(claudeToolName(grant.server, name), tool),
        async call(input, signal) {
          const result = await pool.callTool(grant.server, name, input, {
            signal,
            ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
          });
          return mcpResultToOutcome(result, options.maxResultBytes);
        },
      });
    }
  }
  return tools;
}
