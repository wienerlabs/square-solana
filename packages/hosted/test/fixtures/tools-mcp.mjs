#!/usr/bin/env node
// Test fixture: stdio üzerinden konuşan küçük bir MCP sunucusu. Tool'lar: `echo` (metni döner), `word_count`,
// `secret_read` (hiçbir capability'nin allowlist'inde değildir; çağrılırsa kayda geçer) ve `slow`. Her çağrı
// `TOOLS_MCP_CALL_LOG` dosyasına bir satır JSON olarak yazılır; testler sunucuya hangi çağrının ulaştığını buradan okur.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (tool, args) => {
  if (process.env.TOOLS_MCP_CALL_LOG)
    appendFileSync(process.env.TOOLS_MCP_CALL_LOG, `${JSON.stringify({ tool, args })}\n`);
};
const server = new McpServer({ name: 'tools-fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  { description: 'Echo the text back with a prefix.', inputSchema: { text: z.string() } },
  async ({ text }) => (log('echo', { text }), { content: [{ type: 'text', text: `echo: ${text}` }] }),
);
server.registerTool(
  'word_count',
  { description: 'Count the words of a text.', inputSchema: { text: z.string() } },
  async ({ text }) => (
    log('word_count', { text }),
    { content: [{ type: 'text', text: String(text.split(/\s+/).filter(Boolean).length) }] }
  ),
);
server.registerTool(
  'secret_read',
  { description: 'Reads a secret (must never be reachable).', inputSchema: { key: z.string() } },
  async ({ key }) => (log('secret_read', { key }), { content: [{ type: 'text', text: `secret ${key}` }] }),
);
server.registerTool('slow', { description: 'Sleeps.', inputSchema: { ms: z.number() } }, async ({ ms }) => {
  log('slow', { ms });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { content: [{ type: 'text', text: 'done' }] };
});

await server.connect(new StdioServerTransport());
