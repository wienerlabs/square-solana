#!/usr/bin/env node
// `square-mcp`: süreç giriş noktası. Varsayılan taşıma stdio'dur (Claude Desktop, Claude Code, Cursor);
// `--http` Streamable HTTP sunucusu açar. stdio'da stdout JSON-RPC kanalıdır, günlük yalnızca stderr'e yazılır.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, loadHttpConfig } from './config.js';
import { startHttpServer } from './http.js';
import { packageInfo } from './package-info.js';
import { createSquareMcpServer, depsFromConfig } from './server.js';

const USAGE = `kullanım: square-mcp [--http]
  (seçeneksiz)  stdio taşıması
  --http        Streamable HTTP (SQUARE_MCP_HTTP_HOST, SQUARE_MCP_HTTP_PORT)
Ortam değişkenleri: packages/mcp/README.md`;

const log = (line: string) => process.stderr.write(`${packageInfo.name}: ${line}\n`);

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }
  const unknown = argv.filter((arg) => arg !== '--http');
  if (unknown.length > 0) throw new ConfigError(`bilinmeyen argüman: ${unknown.join(' ')}\n${USAGE}`);
  const http = argv.includes('--http');

  const config = loadConfig();
  if (http && config.signerKeypairPath) {
    throw new ConfigError('SQUARE_SIGNER_KEYPAIR yalnızca stdio taşımasında kullanılabilir');
  }
  const deps = await depsFromConfig(config);
  const mode = deps.write
    ? `yazma${deps.write.signer ? `, yerel imzalayıcı ${deps.write.signer.publicKey.toBase58()}` : ''}`
    : 'yalnızca okuma';

  if (http) {
    const handle = await startHttpServer({ ...loadHttpConfig(), createServer: () => createSquareMcpServer(deps) });
    log(`v${packageInfo.version} ${handle.url} (${mode}) network=${config.network} api=${config.apiUrl}`);
    const stop = () => {
      handle.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }

  const server = createSquareMcpServer(deps);
  await server.connect(new StdioServerTransport());
  log(`v${packageInfo.version} stdio (${mode}) network=${config.network} api=${config.apiUrl}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  log(
    error instanceof ConfigError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error),
  );
  process.exit(1);
});
