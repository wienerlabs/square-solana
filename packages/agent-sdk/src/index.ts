/**
 * @aip/agent-sdk
 *
 * Build AIP-compatible AI agents in minutes.
 *
 * @example
 * ```ts
 * import { createAgent, haiku } from '@aip/agent-sdk';
 *
 * const agent = createAgent({ name: 'Summary Bot', port: 4001 });
 *
 * agent.capability('text.summarize', {
 *   description: 'Summarize Text',
 *   price: '0.10',
 *   handler: haiku('You are a summarization specialist. Keep it under 200 words.'),
 * });
 *
 * agent.start();
 * ```
 */

export { createAgent } from "./agent.js";
export { haiku } from "./haiku.js";
export type {
  AgentOptions,
  AgentCard,
  AgentType,
  CapabilityConfig,
  Pricing,
} from "./types.js";
