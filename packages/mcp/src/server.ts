// Square MCP sunucusu (BE-28). Covenant `mcp/`'nin (Apache-2.0, BE-02 ile taşındı) Square'e uyarlaması:
// okuma tool'ları Square REST API'sini kullanır, yazma tool'ları imzasız tx hazırlar ve yalnızca imzası
// doğrulanmış tx'i gönderir. Sunucu taşımadan bağımsızdır; stdio ve Streamable HTTP `bin.ts` / `http.ts`'te.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SquareApi } from '@squaresdk/solana-sdk';
import { createApi } from './api.js';
import { createChain, type SquareChain } from './chain.js';
import type { SquareMcpConfig } from './config.js';
import { packageInfo } from './package-info.js';
import { registerReadTools } from './tools/discover.js';
import type { ToolContext } from './tools/result.js';
import { registerWriteTools } from './tools/write.js';
import { LocalSigner } from './transactions.js';

export interface SquareMcpDeps {
  network: string;
  api: SquareApi;
  /** Yazma kipi; verilmezse yalnızca okuma tool'ları kaydedilir. */
  write?: { chain: SquareChain; signer: LocalSigner | null } | null;
}

const INSTRUCTIONS = [
  'Square is a compliant agent-to-agent settlement layer on Solana. Institutions open jobs bound to a',
  'registered agent and lock the settlement token in a per-job escrow; the agent accepts and delivers; after the',
  'challenge window a keeper releases the escrow (with a zero-knowledge compliance proof when the job has a',
  'policy). Read tools need no wallet. Write tools return UNSIGNED transactions with a decoded summary: the',
  'user signs them in their own wallet and passes the signed transaction to square_submit_signed_transaction.',
  'This server holds no private key unless the operator explicitly configured a local signer.',
].join(' ');

/** Tool'ları kayıtlı yeni bir `McpServer`; her taşıma bağlantısı kendi örneğini alır. */
export function createSquareMcpServer(deps: SquareMcpDeps): McpServer {
  const server = new McpServer(
    { name: packageInfo.name, version: packageInfo.version },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolContext = { network: deps.network, api: deps.api, write: deps.write ?? null };
  registerReadTools(server, ctx);
  if (deps.write) registerWriteTools(server, { ctx, chain: deps.write.chain, signer: deps.write.signer });
  return server;
}

/** Yapılandırmadan bağımlılıklar: API istemcisi, yazma kipinde zincir erişimi ve yerel imzalayıcı. */
export async function depsFromConfig(config: SquareMcpConfig): Promise<SquareMcpDeps> {
  const api = createApi({ apiUrl: config.apiUrl, timeoutMs: config.timeoutMs, apiKey: config.apiKey });
  if (!config.write) return { network: config.network, api, write: null };
  const chain = createChain({ ...config.write, timeoutMs: config.timeoutMs });
  const signer = config.signerKeypairPath ? await LocalSigner.fromFile(config.signerKeypairPath) : null;
  return { network: config.network, api, write: { chain, signer } };
}
