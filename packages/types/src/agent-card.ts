// Agent card: A2A AgentCard çekirdeği + ERC-8004 tarzı `registrations` + Square fiyatlandırması.
// Zincirde yalnızca `agentCardUri` ve SHA-256 `agentCardHash` durur (BC-44); kart bu şemaya uyar.
// did:aip v2 Solana profili (BC-14) `registrations[]` biçimini belirler; ayrıntılar BE-07 / BE-09'da.
import { z } from 'zod';
import { Address, Hex32, U64 } from './primitives.js';

const HttpsUrl = z.url({ protocol: /^https$/ });

export const AgentSkillSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(40)).max(20),
  examples: z.array(z.string().max(500)).max(10).optional(),
});
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

/** Kayıt bağlantısı: `agentRegistry` = `solana:{chain-ref}:{registry}`, `agentId` = AgentRecord adresi. */
export const AgentRegistrationSchema = z.object({
  agentRegistry: z.string().regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}:[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  agentId: Address,
});
export type AgentRegistration = z.infer<typeof AgentRegistrationSchema>;

/** Beceri başına fiyat; tutar settlement mint'in atomik biriminde. */
export const AgentPricingSchema = z.object({
  skillId: z.string().min(1).max(64),
  amount: U64,
  mint: Address,
});
export type AgentPricing = z.infer<typeof AgentPricingSchema>;

export const AgentCardSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  /** A2A JSON-RPC uç noktası. */
  url: HttpsUrl,
  version: z.string().min(1).max(32),
  provider: z.object({ organization: z.string().min(1).max(120), url: HttpsUrl }).optional(),
  capabilities: z.object({
    streaming: z.boolean().default(false),
    pushNotifications: z.boolean().default(false),
  }),
  defaultInputModes: z.array(z.string().min(1)).min(1),
  defaultOutputModes: z.array(z.string().min(1)).min(1),
  skills: z.array(AgentSkillSchema).min(1).max(50),
  registrations: z.array(AgentRegistrationSchema).min(1),
  pricing: z.array(AgentPricingSchema).max(50).optional(),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** `PUT /v1/agents/{agentRecord}/card` yanıtı: `update_agent` için URI ve kartın SHA-256'sı. */
export const AgentCardHostingSchema = z.object({
  agentCardUri: z.string().min(1).max(200),
  agentCardHash: Hex32,
});
export type AgentCardHosting = z.infer<typeof AgentCardHostingSchema>;
