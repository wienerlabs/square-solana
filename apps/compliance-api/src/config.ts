import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export const config = {
  port: parseInt(optionalEnv('COMPLIANCE_API_PORT', '3002'), 10),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  logLevel: optionalEnv('LOG_LEVEL', 'info'),
  policyServiceUrl: optionalEnv('POLICY_SERVICE_URL', 'http://localhost:3001'),
  database: {
    host: requireEnv('POSTGRES_HOST'),
    port: parseInt(optionalEnv('POSTGRES_PORT', '5432'), 10),
    user: requireEnv('POSTGRES_USER'),
    password: requireEnv('POSTGRES_PASSWORD'),
    database: requireEnv('POSTGRES_DB'),
  },
  stripe: {
    secretKey: requireEnv('STRIPE_SECRET_KEY'),
    apiVersion: optionalEnv('STRIPE_API_VERSION', '2026-03-04.preview'),
  },
  mpp: {
    secretKey: requireEnv('MPP_SECRET_KEY'),
    realm: optionalEnv('MPP_REALM', 'aperture-compliance'),
  },
} as const;
