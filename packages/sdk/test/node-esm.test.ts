import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const run = promisify(execFile);
const script = fileURLToPath(new URL('node-esm/list-claim.mjs', import.meta.url));

test(
  "dist, vitest'in CJS uyumluluğu olmadan düz Node ESM ile açılır; listClaim u64 fiyatı BN ile kodlanır",
  { timeout: 30_000 },
  async () => {
    await run(process.execPath, [script], { env: { ...process.env, NODE_OPTIONS: undefined }, timeout: 20_000 });
  },
);
