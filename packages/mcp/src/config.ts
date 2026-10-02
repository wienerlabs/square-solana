/**
 * Runtime configuration for the Covenant MCP server.
 *
 * Everything is environment-driven and required: the server has no built-in
 * API endpoint, network or timeout, and refuses to start without them.
 */

export interface CovenantMcpConfig {
  /** Base URL of the Covenant HTTP API. */
  baseUrl: string;
  /** Network label surfaced to the agent so it knows which cluster it reads. */
  network: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): CovenantMcpConfig {
  const rawUrl = requireEnv("COVENANT_API_URL");
  // Throws on anything that is not an absolute URL.
  const baseUrl = new URL(rawUrl).toString().replace(/\/+$/, "");

  const rawTimeout = requireEnv("COVENANT_TIMEOUT_MS");
  const timeoutMs = Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`COVENANT_TIMEOUT_MS must be a positive integer, got ${rawTimeout}`);
  }

  return {
    baseUrl,
    network: requireEnv("COVENANT_NETWORK"),
    timeoutMs,
  };
}
