// Agent card: tek şema (BE-09). Aynı belge hem ERC-8004 kayıt dosyasıdır (`type`, `services`,
// `registrations`, `active`; did:aip v2 §5, Solana profili §5.4–§5.6) hem A2A AgentCard'ıdır
// (`url`, `capabilities`, `skills` …). Zincirde yalnızca `agentCardUri` ve kartın baytlarının
// SHA-256'sı (`agentCardHash`) durur (BC-44); DID çözücüsü servisleri `services`'ten üretir.
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

/** ERC-8004 kayıt dosyası türü. */
export const AGENT_CARD_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

/** Kartın servis girdisi; DID belgesinde `{did}#{name-slug}` olur. `endpoint` bir URL ya da DID. */
export const AgentServiceSchema = z.object({
  name: z.string().min(1).max(64),
  endpoint: z.string().min(1).max(512),
  version: z.string().min(1).max(32).optional(),
});
export type AgentService = z.infer<typeof AgentServiceSchema>;

/** Beceri başına fiyat; tutar settlement mint'in atomik biriminde. */
export const AgentPricingSchema = z.object({
  skillId: z.string().min(1).max(64),
  amount: U64,
  mint: Address,
});
export type AgentPricing = z.infer<typeof AgentPricingSchema>;

/**
 * A2A v1.0 `AgentInterface`: istemcinin uç noktayı ve bağlamayı okuduğu girdi. Square yalnızca
 * JSON-RPC bağlamasını sunar (docs/design/a2a.md §1).
 */
export const AgentInterfaceSchema = z.object({
  url: HttpsUrl,
  protocolBinding: z.literal('JSONRPC'),
  protocolVersion: z.string().regex(/^\d{1,4}\.\d{1,4}$/),
});
export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;

export const AgentCardSchema = z
  .object({
    type: z.literal(AGENT_CARD_TYPE),
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
    /** DID belgesinin servisleri; A2A uç noktası `A2A` adıyla burada da yer alır. */
    services: z.array(AgentServiceSchema).min(1).max(20),
    registrations: z.array(AgentRegistrationSchema).min(1),
    pricing: z.array(AgentPricingSchema).max(50).optional(),
    /** `false`: sahip ajanı kart üzerinden duraklattı (did:aip Solana §5.6). */
    active: z.boolean().optional(),
    x402Support: z.boolean().optional(),
    /** A2A v1.0 istemcilerinin uç noktayı okuduğu alan; verilirse `url` ile aynı bir girdi içerir. */
    supportedInterfaces: z.array(AgentInterfaceSchema).min(1).max(8).optional(),
  })
  .refine((card) => card.services.some((service) => service.name === 'A2A' && service.endpoint === card.url), {
    message: "services, endpoint'i url ile aynı bir A2A girdisi içermeli",
    path: ['services'],
  })
  .refine((card) => !card.supportedInterfaces || card.supportedInterfaces.some((entry) => entry.url === card.url), {
    message: "supportedInterfaces, url'i kartın url'i ile aynı bir girdi içermeli",
    path: ['supportedInterfaces'],
  });
export type AgentCard = z.infer<typeof AgentCardSchema>;

/** `PUT /v1/agents/{agentRecord}/card` yanıtı: `update_agent` için URI ve kartın SHA-256'sı. */
export const AgentCardHostingSchema = z.object({
  agentCardUri: z.string().min(1).max(200),
  agentCardHash: Hex32,
});
export type AgentCardHosting = z.infer<typeof AgentCardHostingSchema>;

// ---------------------------------------------------------------- did:aip v1 (AIP) kartı

/**
 * AIP'nin (did:aip v1) kart biçimi. Square kartı değildir; v1 DID'lerini çözen BE-09 ve eski
 * ajanları okuyan araçlar bu biçimi doğrular. Kaynak: dr-wilson-empty/aip-beta
 * `src/lib/protocol/agent-card-schema.ts` @ 5a36fe0 (MIT, BE-07). Farkı: tutar ondalık sayı
 * biçiminde olmalı (kaynak `parseFloat` ile "1abc" gibi değerleri de kabul ediyordu).
 */
export const AipV1AgentTypeSchema = z.enum(['LLM', 'Task', 'Execution']);
export type AipV1AgentType = z.infer<typeof AipV1AgentTypeSchema>;

export const AipV1CapabilitySchema = z.object({
  id: z.string().trim().min(1),
  description: z.string().trim().min(1),
  pricing: z.object({
    amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'ondalık tutar bekleniyor'),
    token: z.literal('USDC'),
    network: z.literal('solana'),
  }),
});
export type AipV1Capability = z.infer<typeof AipV1CapabilitySchema>;

export const AipV1AgentCardSchema = z.object({
  did: z.string().startsWith('did:'),
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  /** Yalnızca http(s); `javascript:`, `data:` vb. reddedilir. */
  endpoint: z.url({ protocol: /^https?$/ }),
  type: AipV1AgentTypeSchema,
  capabilities: z.array(AipV1CapabilitySchema).min(1),
  walletAddress: Address.optional(),
});
export type AipV1AgentCard = z.infer<typeof AipV1AgentCardSchema>;
