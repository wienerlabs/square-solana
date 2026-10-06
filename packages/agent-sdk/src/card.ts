// Agent card (tek şema, `@squaresdk/solana-types` AgentCardSchema): hem ERC-8004 kayıt dosyası hem A2A v1.0
// AgentCard'ı. Kart RFC 8785 kanonik JSON olarak sunulur; zincirdeki `agent_card_hash` bu baytların
// SHA-256'sıdır. API'nin barındırdığı kart da aynı kanonikleştirmeyle yazılır (apps/api cards.ts), bu yüzden
// iki barındırma aynı hash'i verir.
import { createHash } from 'node:crypto';
import type { PublicKey } from '@solana/web3.js';
import { specHashing } from '@squaresdk/solana-sdk';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_TYPE, AgentCardSchema, type AgentCard } from '@squaresdk/solana-types';
import type { AgentCapability } from './types.js';

/** A2A keşif yolu (A2A v1.0; did:aip Solana profili `Agent Card` servisi). */
export const WELL_KNOWN_AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const A2A_PATH = '/a2a';

/** Registry `agent_id`'si (did:aip v2 Solana profili §3.4). */
const AGENT_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface AgentUrls {
  /** Sonda eğik çizgi olmadan public URL. */
  base: string;
  /** Yerel sunucudaki yol öneki (`/` için boş). */
  basePath: string;
  a2a: string;
  card: string;
}

export function agentUrls(publicUrl: string): AgentUrls {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch (error) {
    throw new Error(`createAgent: publicUrl mutlak bir URL olmalı: ${JSON.stringify(publicUrl)}`, { cause: error });
  }
  if (url.protocol !== 'https:') throw new Error(`createAgent: publicUrl https olmalı: ${publicUrl}`);
  if (url.search || url.hash) throw new Error('createAgent: publicUrl sorgu ya da parça içeremez');
  const basePath = url.pathname.replace(/\/+$/, '');
  const base = `${url.origin}${basePath}`;
  return { base, basePath, a2a: `${base}${A2A_PATH}`, card: `${base}${WELL_KNOWN_AGENT_CARD_PATH}` };
}

export function assertAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) {
    throw new Error(`createAgent: agentId [A-Za-z0-9_-]{1,32} olmalı: ${JSON.stringify(agentId)}`);
  }
}

export interface CardInput {
  name: string;
  description: string;
  version: string;
  provider?: { organization: string; url: string };
  urls: AgentUrls;
  did: string;
  capabilities: readonly AgentCapability[];
  chainRef: string;
  registry: PublicKey;
  agentRecord: PublicKey;
  settlementMint: PublicKey;
}

/** Kartı kurar ve şemayla doğrular; geçersiz kart `createAgent`'ta reddedilir. */
export function buildAgentCard(input: CardInput): AgentCard {
  if (input.capabilities.length === 0) throw new Error('createAgent: en az bir capability gerekli');
  const ids = new Set<string>();
  for (const capability of input.capabilities) {
    if (ids.has(capability.id)) throw new Error(`createAgent: capability kimliği iki kez verildi: ${capability.id}`);
    ids.add(capability.id);
    if (capability.price <= 0n || capability.price >= 2n ** 64n) {
      throw new Error(`createAgent: ${capability.id} fiyatı 1 ile u64 aralığında olmalı: ${capability.price}`);
    }
  }
  const card = {
    type: AGENT_CARD_TYPE,
    name: input.name,
    description: input.description,
    url: input.urls.a2a,
    version: input.version,
    ...(input.provider ? { provider: input.provider } : {}),
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: input.capabilities.map((capability) => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      tags: [...capability.tags],
      ...(capability.examples ? { examples: [...capability.examples] } : {}),
    })),
    services: [
      { name: 'A2A', endpoint: input.urls.a2a, version: A2A_PROTOCOL_VERSION },
      { name: 'Agent Card', endpoint: input.urls.card },
      { name: 'DID', endpoint: input.did },
    ],
    registrations: [
      {
        agentRegistry: `solana:${input.chainRef}:${input.registry.toBase58()}`,
        agentId: input.agentRecord.toBase58(),
      },
    ],
    pricing: input.capabilities.map((capability) => ({
      skillId: capability.id,
      amount: capability.price.toString(),
      mint: input.settlementMint.toBase58(),
    })),
    active: true,
    supportedInterfaces: [{ url: input.urls.a2a, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }],
  };
  const parsed = AgentCardSchema.safeParse(card);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`createAgent: agent card geçersiz: ${issues}`);
  }
  return parsed.data;
}

/** Kartın sunulan baytları (RFC 8785) ve SHA-256'sı (hex). */
export function encodeCard(card: AgentCard): { bytes: Uint8Array; hash: string } {
  const bytes = new TextEncoder().encode(specHashing.canonicalizeSpec(card));
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}
