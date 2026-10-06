#!/usr/bin/env node
// Süreç giriş noktası: yapılandırmayı okur ve sunucuyu stdio'ya bağlar (Claude Desktop, Claude Code, Cursor).
// stdout JSON-RPC kanalıdır; loglar stderr'e yazılır. Gizli anahtar loglanmaz, yalnızca açık anahtarı.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { packageInfo } from './package-info.js';
import { createSquareMcpServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const server = createSquareMcpServer({ config, connection });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `${packageInfo.name} ${packageInfo.version} cluster=${config.cluster} signer=${
      config.signer?.publicKey.toBase58() ?? 'none'
    }\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${packageInfo.name}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
