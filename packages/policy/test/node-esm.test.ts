import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const run = promisify(execFile);
const script = fileURLToPath(new URL('node-esm/set-compliance-proof.mjs', import.meta.url));

test(
  "dist, vitest'in CJS uyumluluğu olmadan düz Node ESM ile açılır; set_compliance_proof u64 ve i64 sinyalleri BN ile kodlanır",
  { timeout: 30_000 },
  async () => {
    await run(process.execPath, [script], { env: { ...process.env, NODE_OPTIONS: undefined }, timeout: 20_000 });
  },
);
