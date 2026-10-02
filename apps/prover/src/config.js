// Runtime configuration. Every value comes from the environment and is
// validated at boot; the service refuses to start without it.

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parsePort(name) {
  const raw = requireEnv(name);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got ${raw}`);
  }
  return port;
}

function parseOrigins(name) {
  const origins = requireEnv(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of origins) {
    // Throws on anything that is not an absolute URL.
    new URL(origin);
  }
  if (origins.length === 0) throw new Error(`${name} must list at least one origin`);
  return origins;
}

export const config = Object.freeze({
  port: parsePort('PROVER_SERVICE_PORT'),
  corsOrigins: Object.freeze(parseOrigins('CORS_ORIGINS')),
});
