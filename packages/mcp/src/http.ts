// Streamable HTTP taşıması (MCP 2025-03-26 ve sonrası). Covenant MCP'de bu dosya API'nin HTTP istemcisiydi;
// API erişimi artık SDK'nın `createApiClient`'ıyla (api.ts), bu dosya uzak MCP istemcileri için sunucudur.
// Oturumlu çalışır: `initialize` isteği yeni bir oturum ve kendi `McpServer` örneğini açar, sonraki istekler
// `Mcp-Session-Id` başlığıyla aynı oturuma gider, `DELETE` oturumu kapatır. `allowedHosts` verilirse `Host`
// başlığı listede olmayan istek 403 alır (DNS rebinding koruması). Yerel imzalayıcı bu taşımada kullanılamaz
// (bin.ts): uzak istemci sunucunun anahtarıyla imza attıramaz.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export const MCP_PATH = '/mcp';
/** JSON-RPC istek gövdesi sınırı; tool girdileri (teslimat içeriği dahil) bunun altında kalır. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerOptions {
  host: string;
  port: number;
  allowedHosts: string[] | null;
  /** Her oturum için yeni sunucu. */
  createServer: () => McpServer;
}

export interface HttpServerHandle {
  /** `http://host:port/mcp`. */
  readonly url: string;
  sessionCount(): number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not JSON');
  }
}

const hostname = (header: string | undefined): string | null => {
  if (!header) return null;
  try {
    return new URL(`http://${header}`).hostname;
  } catch {
    return null;
  }
};

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (options.allowedHosts) {
      const host = hostname(req.headers.host);
      if (!host || !options.allowedHosts.includes(host)) return rpcError(res, 403, 'host not allowed');
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
      return;
    }
    if (url.pathname !== MCP_PATH) return rpcError(res, 404, 'not found');

    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const body = req.method === 'POST' ? await readJson(req) : undefined;

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return rpcError(res, 404, 'unknown session');
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return rpcError(res, 400, 'missing session: start with an initialize request');
    }
    const server = options.createServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void server.close();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return rpcError(res, error.status, error.message);
      process.stderr.write(
        `square-mcp http: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      rpcError(res, 500, 'internal error');
    });
  });
  http.listen(options.port, options.host);
  await once(http, 'listening');
  const address = http.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;

  return {
    url: `http://${host}:${address.port}${MCP_PATH}`,
    sessionCount: () => sessions.size,
    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map(({ transport }) => transport.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
