#!/usr/bin/env node
// Komut satırı (BC-30, BC-31):
//   node dist/cli.js init  --config <küme.json> [--records <kayıt.md>]
//   node dist/cli.js smoke --config <küme.json> [--report <rapor.md>]
// Yapılandırma `--config` ya da `SMOKE_CONFIG` ile verilir. `init` kayıt satırlarını (Markdown) standart
// çıktıya, `--records` verilirse dosyaya da yazar. `smoke` raporu varsayılan olarak
// `docs/deploy/smoke-<küme>.md`'ye yazar.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, parseArgs } from 'node:util';
import { loadClusterConfig } from './config.js';
import { createContext } from './context.js';
import { runInit } from './init.js';
import { loadRoleKeys, REPO_ROOT } from './keys.js';
import { loadCircuitArtifacts, localProver, releaseProverWorkers } from './prover.js';
import { initRecordMarkdown, smokeReportMarkdown } from './render.js';
import { runSmoke } from './smoke.js';

/** İlerleme ve hata satırları standart hataya; standart çıktı `init`'in Markdown'ıdır. */
export const stderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** Komutun hatası: mesaj ve (varsa) sebebi. */
export function reportFailure(error: unknown): void {
  stderr(error instanceof Error ? error.message : inspect(error));
  if (error instanceof Error && error.cause) stderr(inspect(error.cause));
}

/** Modül doğrudan çalıştırıldı mı (`node dist/cli.js`); içe aktarıldığında komut çalışmaz. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

export const USAGE = [
  'kullanım:',
  '  init  --config <küme.json> [--records <kayıt.md>]',
  '  smoke --config <küme.json> [--report <rapor.md>]',
].join('\n');

export interface CliArgs {
  command: 'init' | 'smoke';
  config: string;
  output: string | null;
}

export function parseCli(argv: readonly string[], env: NodeJS.ProcessEnv = {}): CliArgs {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { config: { type: 'string' }, records: { type: 'string' }, report: { type: 'string' } },
  });
  const [command, ...rest] = positionals;
  if ((command !== 'init' && command !== 'smoke') || rest.length > 0) throw new Error(USAGE);
  const config = values.config ?? env.SMOKE_CONFIG;
  if (!config) throw new Error(`yapılandırma gerekli: --config ya da SMOKE_CONFIG\n${USAGE}`);
  if (command === 'init' && values.report) throw new Error(`--report yalnızca smoke içindir\n${USAGE}`);
  if (command === 'smoke' && values.records) throw new Error(`--records yalnızca init içindir\n${USAGE}`);
  const output = command === 'init' ? (values.records ?? null) : (values.report ?? null);
  return { command, config: resolve(config), output: output === null ? null : resolve(output) };
}

/** Smoke raporunun varsayılan yolu. */
export const defaultReportPath = (cluster: string, repoRoot: string = REPO_ROOT) =>
  join(repoRoot, 'docs/deploy', `smoke-${cluster}.md`);

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2), process.env);
  const config = loadClusterConfig(args.config);
  const context = createContext(config, loadRoleKeys(config), stderr);
  if (args.command === 'init') {
    const { record } = await runInit(context);
    const markdown = initRecordMarkdown(record);
    process.stdout.write(`${markdown}\n`);
    if (args.output) writeText(args.output, markdown);
    return;
  }
  const prover = localProver(loadCircuitArtifacts());
  try {
    const report = await runSmoke(context, { prover });
    const path = args.output ?? defaultReportPath(config.cluster);
    writeText(path, smokeReportMarkdown(report));
    stderr(`rapor: ${path}`);
  } finally {
    await releaseProverWorkers();
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    // web3.js bağlantısının websocket'i süreci açık tutar.
    () => process.exit(0),
    (error: unknown) => {
      reportFailure(error);
      process.exit(1);
    },
  );
}
