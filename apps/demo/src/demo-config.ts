import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { DELIVERY_URI_MAX_BYTES } from '@squaresdk/solana-agent-sdk';
import { REFUSAL, type RefusalRule } from '@squaresdk/solana-policy';
import {
  Address,
  ClusterConfigSchema,
  KeyPath,
  PositiveSecs,
  U64,
  parseClusterConfig,
  type ClusterConfig,
} from '@squaresdk/solana-smoke/config';
import { POLICY_CIRCUIT_LIMITS, PolicyCategorySchema, TimeWindowSchema } from '@squaresdk/solana-types';
import { z } from 'zod';
import { basePathOf, DELIVERIES_PATH } from './delivery.js';
import { RPC_MAX_MULTIPLE_ACCOUNTS, RPC_MAX_SIGNATURES, type ReportLimits } from './report.js';

export const REPORT_ROLES = ['payer', 'institution', 'agent', 'buyer', 'keeper'] as const;
export type ReportRole = (typeof REPORT_ROLES)[number];
export const MAX_POLICIES = 8;
export const MAX_EXTRA_BUYERS = 15;
export const MAX_CALLER_INSTITUTIONS = 8;
const WORK_HASH_HEX_LENGTH = 64;
const REFUSAL_RULES = Object.keys(REFUSAL) as [RefusalRule, ...RefusalRule[]];

const ROLE_TARGET = new RegExp(`^(${REPORT_ROLES.join('|')})(:usdc)?$`);
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,32}$/;

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

const isAddress = (value: string) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

export const isReportTarget = (value: string) =>
  ROLE_TARGET.test(value) || value === 'mint' || value === 'institution:pda' || isAddress(value);

export function deliveryUriBytes(publicUrl: string): number {
  const prefix = `${new URL(publicUrl).origin}${basePathOf(publicUrl)}${DELIVERIES_PATH}/`;
  return Buffer.byteLength(prefix, 'utf8') + WORK_HASH_HEX_LENGTH;
}

export function expectedRefusalCode(rules: readonly RefusalRule[]): number {
  return rules.reduce((code, rule) => code | REFUSAL[rule], 0);
}

const distinct = (items: readonly unknown[]) => new Set(items.map(String)).size === items.length;

const Name = z.string().regex(NAME, 'küçük harf, rakam ve tire (en fazla 32)');
const Positive = U64.refine((value) => value > 0n, { message: 'sıfır olamaz' });

const PolicySchema = z.object({
  maxPerTx: Positive,
  maxDaily: Positive,
  dailyCeiling: Positive,
  categories: z
    .array(PolicyCategorySchema)
    .min(1)
    .max(POLICY_CIRCUIT_LIMITS.allowedCategories)
    .refine((items) => new Set(items).size === items.length, { message: 'kategori tekrar edemez' }),
  timeWindow: TimeWindowSchema.nullable(),
});
export type DemoPolicyValues = z.infer<typeof PolicySchema>;

const RetrySchema = z
  .object({
    minDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
    submitMarginSecs: z.number().int().min(0),
  })
  .refine((retry) => retry.maxDelayMs >= retry.minDelayMs, {
    message: 'maxDelayMs, minDelayMs değerinden küçük olamaz',
    path: ['maxDelayMs'],
  });

const TimingSchema = z.object({
  taskTimeoutSecs: PositiveSecs,
  claimListingTimeoutSecs: PositiveSecs,
  a2aRequestTimeoutSecs: PositiveSecs,
  pollIntervalMs: z.number().int().positive(),
  proofDayMarginSecs: PositiveSecs,
});
export type DemoTiming = z.infer<typeof TimingSchema>;

const SeedSchema = z.object({
  institutionName: z
    .string()
    .refine((value) => utf8Length(value) >= 1 && utf8Length(value) <= 64, { message: 'kurum adı 1 ile 64 bayt' }),
  policySecret: KeyPath,
  output: KeyPath.optional(),
  policies: z
    .record(Name, PolicySchema)
    .refine((items) => Object.keys(items).length >= 1 && Object.keys(items).length <= MAX_POLICIES, {
      message: `1 ile ${MAX_POLICIES} politika`,
    }),
  extraBuyers: z.array(Address).max(MAX_EXTRA_BUYERS).default([]),
  funding: z.object({
    institutionUsdc: U64,
    buyerUsdc: U64,
    agentLamports: U64,
    keeperLamports: U64,
  }),
  screening: z.object({ minRemainingSecs: PositiveSecs }),
});

const AgentSchema = z.object({
  agentId: z.string().regex(AGENT_ID, '[A-Za-z0-9_-], 1 ile 32 karakter'),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  version: z.string().min(1).max(32),
  publicUrl: z
    .url({ protocol: /^https$/ })
    .transform((value) => value.replace(/\/+$/, ''))
    .refine((value) => !/[?#]/.test(value), { message: 'sorgu ya da parça içeremez' })
    .refine((value) => deliveryUriBytes(value) <= DELIVERY_URI_MAX_BYTES, {
      message: `teslimat adresi (<publicUrl>${DELIVERIES_PATH}/<64 hex>) ${DELIVERY_URI_MAX_BYTES} baytı aşıyor`,
    }),
  price: Positive,
  autoListClaimBps: z.number().int().min(1).max(9_999).optional(),
  maxReportAccounts: z.number().int().min(1).max(RPC_MAX_MULTIPLE_ACCOUNTS),
  maxReportSignatures: z.number().int().min(0).max(RPC_MAX_SIGNATURES),
  retry: RetrySchema,
  institutions: z
    .array(Address)
    .max(MAX_CALLER_INSTITUTIONS)
    .refine(distinct, { message: 'kurum adresi tekrar edemez' })
    .default([]),
  wallet: Address.optional(),
});

const ScenarioSchema = z
  .object({
    policy: Name,
    expect: z.enum(['approved', 'refused']),
    amount: Positive,
    paymentCategory: PolicyCategorySchema,
    challengePeriodSecs: PositiveSecs,
    deadlineSecs: PositiveSecs,
    claimSale: z.boolean().default(false),
    refusalRules: z
      .array(z.enum(REFUSAL_RULES))
      .min(1)
      .refine(distinct, { message: 'ret kuralı tekrar edemez' })
      .optional(),
    report: z.object({
      targets: z
        .array(z.string().refine(isReportTarget, { message: 'rol, rol:usdc, institution:pda, mint ya da adres' }))
        .min(1),
      signatures: z.number().int().min(0),
    }),
  })
  .refine((s) => s.deadlineSecs > s.challengePeriodSecs, {
    message: 'deadline challenge süresinden uzun olmalı',
    path: ['deadlineSecs'],
  })
  .refine((s) => !(s.claimSale && s.expect === 'refused'), {
    message: 'ret senaryosunda alacak satılmaz (alıcıya ödenmez)',
    path: ['claimSale'],
  })
  .refine((s) => (s.expect === 'refused') === (s.refusalRules !== undefined), {
    message: 'refusalRules ret senaryosunda zorunlu, onay senaryosunda verilmez',
    path: ['refusalRules'],
  });
export type ScenarioValues = z.infer<typeof ScenarioSchema>;

const DemoSchema = z.object({
  agent: AgentSchema,
  timing: TimingSchema,
  scenarios: z.record(Name, ScenarioSchema).refine((items) => Object.keys(items).length >= 1, {
    message: 'en az bir senaryo',
  }),
});

const SectionsSchema = z
  .object({ seed: SeedSchema.optional(), demo: DemoSchema.optional() })
  .superRefine((sections, ctx) => {
    const { seed, demo } = sections;
    if (!demo) return;
    for (const [name, scenario] of Object.entries(demo.scenarios)) {
      if (seed && !(scenario.policy in seed.policies)) {
        ctx.addIssue({
          code: 'custom',
          path: ['demo', 'scenarios', name, 'policy'],
          message: `seed.policies içinde yok: ${scenario.policy}`,
        });
      }
      if (scenario.amount < demo.agent.price) {
        ctx.addIssue({
          code: 'custom',
          path: ['demo', 'scenarios', name, 'amount'],
          message: `agent'ın fiyatından (${demo.agent.price}) az`,
        });
      }
      if (scenario.report.targets.length > demo.agent.maxReportAccounts) {
        ctx.addIssue({
          code: 'custom',
          path: ['demo', 'scenarios', name, 'report', 'targets'],
          message: `en fazla demo.agent.maxReportAccounts (${demo.agent.maxReportAccounts}) hedef`,
        });
      }
      if (scenario.report.signatures > demo.agent.maxReportSignatures) {
        ctx.addIssue({
          code: 'custom',
          path: ['demo', 'scenarios', name, 'report', 'signatures'],
          message: `en fazla demo.agent.maxReportSignatures (${demo.agent.maxReportSignatures})`,
        });
      }
      if (scenario.claimSale && demo.agent.autoListClaimBps === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['demo', 'scenarios', name, 'claimSale'],
          message: 'alacak satışı için demo.agent.autoListClaimBps gerekli',
        });
      }
    }
  });

export type SeedValues = z.infer<typeof SeedSchema>;
export type DemoValues = z.infer<typeof DemoSchema>;
export type DemoAgentSettings = DemoValues['agent'];

export const reportLimitsOf = (
  agent: Pick<DemoAgentSettings, 'maxReportAccounts' | 'maxReportSignatures'>,
): ReportLimits => ({
  maxAccounts: agent.maxReportAccounts,
  maxSignatures: agent.maxReportSignatures,
});

export interface DemoConfig {
  cluster: ClusterConfig;
  seed: SeedValues | undefined;
  demo: DemoValues | undefined;
}

const AgentConfigSchema = ClusterConfigSchema.pick({
  cluster: true,
  rpcUrl: true,
  commitment: true,
  programIds: true,
  lookupTable: true,
  computeUnitPrice: true,
}).extend({
  keys: z.object({ agent: KeyPath }),
  demo: z.object({ agent: AgentSchema }),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const resolvePath = (baseDir: string, path: string) => (isAbsolute(path) ? path : resolve(baseDir, path));

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `  ${issue.path.join('.') || '(kök)'}: ${issue.message}`).join('\n');
}

function readConfigFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`yapılandırma okunamadı (${path}): ${(error as Error).message}`, { cause: error });
  }
}

export function parseDemoConfig(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv = {}): DemoConfig {
  const cluster = parseClusterConfig(raw, baseDir, env);
  const result = SectionsSchema.safeParse(raw);
  if (!result.success) throw new Error(`demo yapılandırması geçersiz:\n${issuesOf(result.error)}`);
  const { seed, demo } = result.data;
  return {
    cluster,
    seed: seed && {
      ...seed,
      policySecret: resolvePath(baseDir, seed.policySecret),
      ...(seed.output === undefined ? {} : { output: resolvePath(baseDir, seed.output) }),
    },
    demo,
  };
}

export function loadDemoConfig(path: string, env: NodeJS.ProcessEnv = process.env): DemoConfig {
  return parseDemoConfig(readConfigFile(path), dirname(resolve(path)), env);
}

export function parseAgentConfig(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv = {}): AgentConfig {
  const rpcOverride = env.SMOKE_RPC_URL?.trim();
  const input =
    rpcOverride && typeof raw === 'object' && raw !== null ? { ...(raw as object), rpcUrl: rpcOverride } : raw;
  const result = AgentConfigSchema.safeParse(input);
  if (!result.success) throw new Error(`agent yapılandırması geçersiz:\n${issuesOf(result.error)}`);
  return { ...result.data, keys: { agent: resolvePath(baseDir, result.data.keys.agent) } };
}

export function loadAgentConfig(path: string, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  return parseAgentConfig(readConfigFile(path), dirname(resolve(path)), env);
}

export function requireSeed(config: DemoConfig): SeedValues {
  if (!config.seed) throw new Error('yapılandırmada "seed" bölümü yok');
  return config.seed;
}

export function requireDemo(config: DemoConfig): DemoValues {
  if (!config.demo) throw new Error('yapılandırmada "demo" bölümü yok');
  return config.demo;
}

export function selectScenarios(demo: DemoValues, names: readonly string[]): [string, ScenarioValues][] {
  const all = Object.entries(demo.scenarios);
  if (names.length === 0) return all;
  return names.map((name) => {
    const scenario = demo.scenarios[name];
    if (!scenario) throw new Error(`bilinmeyen senaryo: ${name} (${all.map(([n]) => n).join(', ')})`);
    return [name, scenario];
  });
}
