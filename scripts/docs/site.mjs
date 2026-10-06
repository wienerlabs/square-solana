#!/usr/bin/env node
// Geliştirici dokümantasyonu (BE-31).
//   build: tek statik site, `dist/docs/`.
//     - TypeScript paketlerinin referansı (TypeDoc, `typedoc.json`) ve rehber dokümanlar: protokol, runbook'lar,
//       tasarım, deploy kayıtları.
//     - HTTP API referansı OpenAPI'den: `dist/docs/api/index.html` (Redocly).
//   check: SDK referansının bütünlüğü. `@squaresdk/solana-sdk`'nin her dışa aktarımı ve arayüz üyesi açıklamalıdır.
//     Hariç olanlar:
//     - IDL'den üretilen tipler (`src/idl/`): açıklamaları sözleşmenin IDL'indedir.
//     - Sabitlerin satır içi tip alanları (ör. ABI girdileri).
//     API referansının bütünlüğü `pnpm openapi:lint`'tedir (`redocly.yaml`).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Application, Logger, LogLevel } from 'typedoc';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SDK = 'packages/sdk';
const GENERATED = /\/src\/idl\//;
const INLINE = /\.__type\b/;

/** TypeDoc uyarılarını toplayan logger. */
class Collector extends Logger {
  messages = [];
  log(message, level) {
    super.log(message, level);
    if (level >= LogLevel.Warn) this.messages.push(String(message));
  }
}

/** SDK'nın açıklaması olmayan dışa aktarımları (üretilen ve satır içi alanlar hariç). */
export async function undocumented() {
  const app = await Application.bootstrap({
    entryPointStrategy: 'resolve',
    entryPoints: [`${ROOT}${SDK}/src/index.ts`],
    tsconfig: `${ROOT}${SDK}/tsconfig.json`,
    validation: { notExported: false, invalidLink: false, notDocumented: true },
    logLevel: 'Warn',
  });
  const collector = new Collector();
  app.logger = collector;
  const project = await app.convert();
  if (!project) throw new Error(`TypeDoc SDK projesini çeviremedi:\n${collector.messages.join('\n')}`);
  app.validate(project);
  return collector.messages
    .filter((message) => message.includes('does not have any documentation'))
    .filter((message) => !GENERATED.test(message) && !INLINE.test(message))
    .map((message) => message.replace(/, does not have any documentation$/, ''));
}

async function build() {
  const app = await Application.bootstrapWithPlugins({ options: `${ROOT}typedoc.json` });
  const project = await app.convert();
  if (!project) throw new Error('TypeDoc projeyi çeviremedi');
  await app.generateDocs(project, app.options.getValue('out'));
  execFileSync('pnpm', ['exec', 'redocly', 'build-docs', 'square', '-o', 'dist/docs/api/index.html'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  console.log('[docs] dist/docs: SDK ve paket referansı, rehberler; dist/docs/api/index.html: HTTP API referansı');
}

async function check() {
  const missing = await undocumented();
  if (missing.length > 0) {
    console.error(`[docs] ❌ SDK referansında açıklaması olmayan ${missing.length} öğe:`);
    for (const entry of missing) console.error(`  ${entry}`);
    process.exit(1);
  }
  console.log('[docs] ✓ SDK referansı eksiksiz: her dışa aktarım ve üye açıklamalı');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'build') await build();
  else if (command === 'check') await check();
  else {
    console.error('kullanım: node scripts/docs/site.mjs build|check');
    process.exit(2);
  }
}
