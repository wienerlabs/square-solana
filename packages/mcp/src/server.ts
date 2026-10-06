// Square MCP sunucusu (BE-28): okuma araçları zincirden (tools/read.ts), yazma araçları imza akışıyla
// (tools/write.ts, signing.ts). Taşımadan bağımsızdır; süreç giriş noktası bin.ts'tir (stdio).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Connection } from '@solana/web3.js';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { createChainReader } from './chain.js';
import type { SquareMcpConfig } from './config.js';
import { packageInfo } from './package-info.js';
import { createSigning } from './signing.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

export const SERVER_INSTRUCTIONS = [
  'Square is escrowed agent payments on Solana. An institution opens a job bound to an agent record and locks USDC',
  'in the job escrow; the agent accepts, delivers (work hash and URI on chain) and, after the challenge window, the',
  "keeper releases the escrow. With a spending policy the release also needs the institution's compliance proof.",
  'Read tools need no wallet. Write tools need the signature of the role wallet (institution or agent): the server',
  'signs only for its own keypair, otherwise it returns the unsigned transaction.',
].join(' ');

export function createSquareMcpServer(deps: { config: SquareMcpConfig; connection: Connection }): McpServer {
  const { config, connection } = deps;
  const client = createSquareClient({ connection, programIds: config.programIds, commitment: 'confirmed' });
  const reader = createChainReader({ client, connection });
  const server = new McpServer(
    { name: packageInfo.name, version: packageInfo.version },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerReadTools(server, { reader, config });
  registerWriteTools(server, { client, connection, reader, signing: createSigning({ connection, config }), config });
  return server;
}
