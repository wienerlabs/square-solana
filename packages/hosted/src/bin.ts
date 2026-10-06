#!/usr/bin/env node
// `square-hosted`: süreç giriş noktası. Yapılandırmayı yükler ve doğrular; geçersizse hiçbir şey başlatmadan çıkar.
// Günlük stderr'e yazılır; anahtarlar ve ortam değerleri yazılmaz.
import { HostedConfigError } from './config.js';
import { USAGE, parseArgs, runFromConfig } from './runner.js';

const log = (line: string) => process.stderr.write(`square-hosted: ${line}\n`);

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args === 'help') {
    process.stderr.write(`${USAGE}\n`);
    return;
  }
  const logger = { info: log, error: (line: string) => log(`hata: ${line}`) };
  const { loaded, hosted } = await runFromConfig(args, process.env, { logger });
  const { config } = loaded;
  if (!hosted) {
    log(
      `yapılandırma geçerli: ${config.agent.agentId}, ${config.capabilities.length} capability` +
        `${config.delegation ? ', delegasyon' : ''}${config.duties ? ", duty'ler" : ''}`,
    );
    return;
  }
  log(
    `${config.agent.agentId} ${hosted.agent.a2aUrl} (${config.agent.listen.host}:${config.agent.listen.port}), ` +
      `capability'ler: ${config.capabilities.map((capability) => capability.id).join(', ')}`,
  );
  const stop = () => {
    hosted.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  log(
    error instanceof HostedConfigError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error),
  );
  process.exit(1);
});
