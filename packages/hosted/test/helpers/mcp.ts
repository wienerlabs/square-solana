// Test fixture: bellek içi taşımayla bağlanan MCP sunucusu (fixtures/tools-mcp.mjs'in süreç içi eşi) ve onu
// kullanan havuz. Sunucuya ulaşan her çağrı `calls`'a yazılır.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpClientPool } from '@squaresdk/solana-mcp/client';
import { z } from 'zod';

export interface ToolServer {
  calls: { tool: string; args: unknown }[];
  pool(name?: string): McpClientPool;
}

export function toolServer(options: { bigBytes?: number } = {}): ToolServer {
  const calls: { tool: string; args: unknown }[] = [];
  const create = () => {
    const server = new McpServer({ name: 'tools-memory', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echo the text.', inputSchema: { text: z.string() } },
      async ({ text }) => {
        calls.push({ tool: 'echo', args: { text } });
        return { content: [{ type: 'text', text: `echo: ${text}` }] };
      },
    );
    server.registerTool(
      'secret_read',
      { description: 'Secret.', inputSchema: { key: z.string() } },
      async ({ key }) => {
        calls.push({ tool: 'secret_read', args: { key } });
        return { content: [{ type: 'text', text: `secret ${key}` }] };
      },
    );
    server.registerTool('big', { description: 'Large output.', inputSchema: {} }, async () => {
      calls.push({ tool: 'big', args: {} });
      return { content: [{ type: 'text', text: 'x'.repeat(options.bigBytes ?? 10_000) }] };
    });
    server.registerTool('fails', { description: 'Always fails.', inputSchema: {} }, async () => {
      calls.push({ tool: 'fails', args: {} });
      return { content: [{ type: 'text', text: 'upstream down' }], isError: true };
    });
    server.registerTool('slow', { description: 'Sleeps.', inputSchema: { ms: z.number() } }, async ({ ms }) => {
      calls.push({ tool: 'slow', args: { ms } });
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { content: [{ type: 'text', text: 'done' }] };
    });
    server.registerTool('dotted.name', { description: 'Name Claude cannot take.', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'never' }],
    }));
    return server;
  };
  return {
    calls,
    pool: (name = 'tools') =>
      new McpClientPool({
        servers: {
          [name]: {
            type: 'transport',
            create: async () => {
              const [client, server] = InMemoryTransport.createLinkedPair();
              await create().connect(server);
              return client;
            },
          },
        },
        maxConcurrency: 4,
        toolCacheTtlMs: 60_000,
        requestTimeoutMs: 5_000,
        reconnect: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      }),
  };
}
