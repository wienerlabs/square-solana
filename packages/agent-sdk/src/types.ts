/** Agent type classification */
export type AgentType = "LLM" | "Task" | "Execution";

/** Capability pricing; every field is explicit. */
export interface Pricing {
  amount: string;
  /** Payment token (symbol or mint) the caller pays in. */
  token: string;
  /** Network the payment settles on. */
  network: string;
}

/** Capability definition */
export interface CapabilityConfig {
  description: string;
  price: Pricing;
  handler: (input: string) => Promise<string>;
}

/** Agent Card (A2A-compatible) */
export interface AgentCard {
  did: string;
  name: string;
  version: string;
  endpoint: string;
  type: AgentType;
  walletAddress: string;
  capabilities: Array<{
    id: string;
    description: string;
    pricing: { amount: string; token: string; network: string };
  }>;
}

/** Agent configuration */
export interface AgentOptions {
  /** Agent display name */
  name: string;
  /** HTTP port to listen on */
  port: number;
  /**
   * Externally reachable base URL of this agent (scheme + host [+ path]).
   * The Agent Card advertises `${publicUrl}/a2a` as the A2A endpoint.
   */
  publicUrl: string;
  /**
   * Solana wallet address (base58 Ed25519 public key) for receiving
   * payments AND for deriving the canonical did:aip identifier.
   * REQUIRED as of @aip/agent-sdk 0.2.0 — the previous `did:aip:sdk:*`
   * fallback violated the did:aip Method Specification §3.2.
   */
  walletAddress: string;
  /**
   * Owner-scoped slug used as the agent_id component of the DID.
   * 1–32 chars from [a-z0-9_-]. If omitted, derived from `name`.
   */
  agentId?: string;
  /** Agent type */
  type: AgentType;
  /** Semantic version reported in the Agent Card */
  version: string;
  /**
   * Explicit DID override (advanced use only). When set, must be a
   * canonical did:aip identifier matching the §3.2 ABNF. Most callers
   * should leave this undefined and let the SDK construct it from
   * walletAddress + agentId.
   */
  did?: string;
  /** Receives lifecycle and task events; nothing is printed when omitted. */
  logger?: AgentLogger;
}

/** Minimal logger the agent reports to. */
export interface AgentLogger {
  info(message: string): void;
  error(message: string): void;
}
