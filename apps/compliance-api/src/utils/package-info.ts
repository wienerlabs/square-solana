import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/// Name and version reported by /health and the OpenAPI document come from
/// package.json. src/utils (tsx) and dist/utils (node) both sit two levels
/// below the package root.
const PackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

export const packageInfo = PackageJsonSchema.parse(
  JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')),
);
