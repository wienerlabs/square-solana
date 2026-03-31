/** Agent type classification */
export type AgentType = "LLM" | "Task" | "Execution";

/** Capability pricing */
export interface Pricing {
  amount: string;
  token?: string;   // default: "USDC"
  network?: string;  // default: "solana"
}

/** Capability definition */
export interface CapabilityConfig {
  description: string;
  price: string | Pricing;
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
  /** Agent type */
  type?: AgentType;
  /** Semantic version */
  version?: string;
  /** Solana wallet address for receiving payments */
  walletAddress?: string;
  /** Custom DID (auto-generated if omitted) */
  did?: string;
}
