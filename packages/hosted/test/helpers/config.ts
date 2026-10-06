// Test fixture: geçerli bir hosted agent yapılandırması ve kurum politikası. Testler alanları üzerine yazar.
import { Keypair } from '@solana/web3.js';
import type { PolicyDocument } from '@squaresdk/solana-types';
import { PROGRAM_IDS } from './sim.js';

export const LIMITS = {
  timeoutMs: 10_000,
  maxTurns: 6,
  maxTokens: 2_000,
  maxTotalTokens: 20_000,
  maxConcurrency: 2,
  maxQueue: 4,
  maxToolResultBytes: 4_096,
};

/** Tam yapılandırma (ham, şemadan geçmemiş). */
export function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    agent: {
      name: 'Kurum Ajanı',
      description: 'Konfigürasyondan çalışan kurum agent’ı',
      version: '1.0.0',
      publicUrl: 'https://kurum-ajani.square.test',
      agentId: 'kurum-ajani',
      register: 'none',
      listen: { host: '127.0.0.1', port: 0 },
      callers: [{ keySha256: 'a'.repeat(64), institutions: [Keypair.generate().publicKey.toBase58()] }],
    },
    chain: {
      rpcUrl: 'http://127.0.0.1:8899',
      commitment: 'confirmed',
      programIds: {
        registry: PROGRAM_IDS.registry.toBase58(),
        policy: PROGRAM_IDS.policy.toBase58(),
        verifier: PROGRAM_IDS.verifier.toBase58(),
        escrow: PROGRAM_IDS.escrow.toBase58(),
      },
    },
    api: { baseUrl: 'https://api.square.test', apiKeyEnv: 'SQUARE_API_KEY' },
    store: { type: 'postgres', urlEnv: 'DATABASE_URL' },
    signers: { agent: { type: 'keypair', keypairPath: './agent.json' } },
    mcp: {
      servers: {
        tools: {
          type: 'stdio',
          command: 'node',
          args: ['./tools-mcp.mjs'],
          env: { TOKEN: { fromEnv: 'TOOLS_TOKEN' } },
        },
      },
      maxConcurrency: 4,
      toolCacheTtlMs: 60_000,
      requestTimeoutMs: 10_000,
      reconnect: { maxAttempts: 2, backoffMs: 10, maxBackoffMs: 100 },
    },
    capabilities: [
      {
        id: 'text.echo',
        name: 'Yankı',
        description: 'Metni MCP tool’uyla yankılar',
        tags: ['text'],
        price: '1000000',
        instructions: 'Use the echo tool and return its output.',
        model: 'claude-opus-5-5',
        tools: [{ server: 'tools', allow: ['echo'] }],
        limits: LIMITS,
      },
    ],
    ...overrides,
  };
}

/** Kurumun politikası: işlem başı 5, gizli günlük 8, public günlük 10 birim (6 ondalık). */
export function policyDocument(mint: string, overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return {
    institution: Keypair.generate().publicKey.toBase58(),
    policyId: '11'.repeat(32),
    version: 1,
    dailyCeiling: '10000000',
    maxDaily: '8000000',
    maxPerTx: '5000000',
    tokenWhitelist: [mint],
    blockedPayees: [],
    allowedCategories: ['research', 'translation'],
    timeWindow: null,
    ...overrides,
  };
}

/** Travel Rule kaydının tüzel kişi tarafı (IVMS101 alt kümesi). */
export function legalPerson(name: string, accountNumber: string) {
  return {
    kind: 'legal' as const,
    primaryIdentifier: name,
    secondaryIdentifier: null,
    accountNumber,
    address: { street: null, city: 'İstanbul', postcode: null, country: 'TR' },
    nationalIdentification: null,
    dateOfBirth: null,
    placeOfBirth: null,
    countryOfResidence: 'TR',
  };
}
