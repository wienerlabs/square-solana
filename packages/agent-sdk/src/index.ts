/**
 * @squaresdk/solana-agent-sdk
 *
 * Build AIP-compatible AI agents in minutes. Every deployment-specific value
 * (port, public URL, wallet, model, pricing) is passed in explicitly.
 *
 * @example
 * ```ts
 * import { createAgent, haiku } from '@squaresdk/solana-agent-sdk';
 *
 * const agent = createAgent({
 *   name: 'Summary Bot',
 *   port: Number(process.env.PORT),
 *   publicUrl: process.env.AGENT_PUBLIC_URL,
 *   type: 'Task',
 *   version: '1.2.0',
 *   walletAddress: process.env.AGENT_WALLET,
 * });
 *
 * agent.capability('text.summarize', {
 *   description: 'Summarize Text',
 *   price: { amount: '0.10', token: 'USDC', network: 'solana' },
 *   handler: haiku('Keep it under 200 words.', process.env.ANTHROPIC_MODEL, 1024),
 * });
 *
 * agent.start();
 * ```
 */

export { createAgent } from "./agent";
export type { Agent } from "./agent";
export { haiku } from "./haiku";
export type {
  AgentOptions,
  AgentCard,
  AgentLogger,
  AgentType,
  CapabilityConfig,
  Pricing,
} from "./types";
