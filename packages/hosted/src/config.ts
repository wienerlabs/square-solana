// Hosted agent'ın konfigürasyonu (BE-29): agent kimliği ve kaydı, zincir, MCP sunucuları, capability'ler (talimat,
// model, izinli MCP tool'ları, fiyat, zaman / token / eşzamanlılık sınırları), delegasyon ve duty'ler. Dosya JSON ya
// da YAML'dır; açılışta zod şemasıyla doğrulanır ve geçersizse hiçbir şey başlatılmadan reddedilir. Sırlar dosyaya
// yazılmaz: API anahtarları ortam değişkeni adıyla (`…Env`), keypair'ler dosya yoluyla verilir. Dağıtıma bağlı
// hiçbir değerin varsayılanı yoktur.
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { normalizePolicy } from '@squaresdk/solana-policy';
import {
  Address,
  PolicyCategorySchema,
  PolicyDocumentSchema,
  TravelRulePersonSchema,
  TravelRuleVaspSchema,
  U64,
  type PolicyDocument,
} from '@squaresdk/solana-types';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Yapılandırma okunamadı ya da geçersiz; mesaj her sorunu yoluyla listeler. */
export class HostedConfigError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length ? `${message}\n${issues.map((issue) => `  - ${issue}`).join('\n')}` : message);
    this.name = 'HostedConfigError';
  }
}

const distinct = <T>(items: readonly T[]) => new Set(items).size === items.length;
const PositiveInt = z.number().int().positive();
const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'ortam değişkeni adı bekleniyor (A-Z, 0-9, _)');
const FilePath = z.string().min(1);
const HttpUrl = z.url({ protocol: /^https?$/ });
const HttpsUrl = z.url({ protocol: /^https$/, error: 'https adresi bekleniyor' });

/**
 * MCP sunucusunun havuzdaki adı. Claude'a giden tool adı `${sunucu}__${tool}` olduğu için alt çizgi içeremez;
 * böylece ayırıcı tek anlamlıdır.
 */
export const McpServerName = z.string().regex(/^[A-Za-z0-9-]{1,24}$/, 'sunucu adı [A-Za-z0-9-]{1,24} olmalı');

/** Değer ya düz metindir ya da ortamdan okunur (`{ fromEnv: AD }`); sırlar ikincisiyle verilir. */
export const EnvValueSchema = z.union([z.string(), z.object({ fromEnv: EnvName }).strict()]);
export type EnvValue = z.infer<typeof EnvValueSchema>;

export const McpServerConfigSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      /** Alt sürecin ortamı; verilmeyen değişkenler alt sürece geçmez. */
      env: z.record(EnvName, EnvValueSchema).optional(),
      cwd: FilePath.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('http'),
      url: HttpUrl,
      headers: z.record(z.string().min(1), EnvValueSchema).optional(),
    })
    .strict(),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** Bir sunucudan izin verilen tool'lar. Liste dışındaki tool Claude'a hiç gösterilmez ve çağrılamaz. */
export const ToolGrantSchema = z
  .object({
    server: McpServerName,
    allow: z.array(z.string().min(1)).min(1).refine(distinct, { message: 'tool tekrar edemez' }),
  })
  .strict();
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

/** Capability'nin çalışma sınırları; her çalıştırma bunlarla yalıtılır. */
export const CapabilityLimitsSchema = z
  .object({
    /** Bir çalıştırmanın (Claude + tool çağrıları) en uzun süresi; kuyrukta bekleme sayılmaz. */
    timeoutMs: PositiveInt,
    /** Claude'a en çok istek sayısı (tool turu başına bir). */
    maxTurns: z.number().int().min(1).max(100),
    /** Yanıt başına `max_tokens`. */
    maxTokens: PositiveInt,
    /** Çalıştırmanın bütün isteklerindeki girdi + çıktı token toplamı. */
    maxTotalTokens: PositiveInt,
    /** Aynı anda yürüyen çalıştırma sayısı. */
    maxConcurrency: PositiveInt,
    /** Slot bekleyen çalıştırma sayısı; doluysa iş hemen düşer. */
    maxQueue: z.number().int().min(0),
    /** Tek tool sonucunun en büyük boyutu (UTF-8 bayt); büyüğü Claude'a hata olarak döner. */
    maxToolResultBytes: PositiveInt,
  })
  .strict()
  .refine((limits) => limits.maxTokens <= limits.maxTotalTokens, {
    message: "maxTokens, maxTotalTokens'tan büyük olamaz",
    path: ['maxTokens'],
  });
export type CapabilityLimits = z.infer<typeof CapabilityLimitsSchema>;

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const CapabilityConfigSchema = z
  .object({
    /** Kartta `skills[].id`, job spec'inde `capability`. */
    id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'capability kimliği [A-Za-z0-9._-]{1,64} olmalı'),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string().min(1)),
    examples: z.array(z.string().min(1)).optional(),
    /** En düşük fiyat, settlement mint'in atomik biriminde (u64 ondalık dize). */
    price: U64,
    /** Claude'un sistem talimatı. */
    instructions: z.string().trim().min(1),
    model: z.string().min(1),
    effort: z.enum(EFFORT_LEVELS).optional(),
    /** Teslimatın içerik tipi. */
    contentType: z.string().min(1).default('text/markdown; charset=utf-8'),
    tools: z.array(ToolGrantSchema).default([]),
    /** `square_delegate_job` tool'unu açar; delegasyon kurum politikasıyla sınırlıdır. */
    delegation: z.boolean().default(false),
    limits: CapabilityLimitsSchema,
  })
  .strict()
  .refine((capability) => distinct(capability.tools.map((grant) => grant.server)), {
    message: "aynı sunucu bir capability'de bir kez listelenir",
    path: ['tools'],
  });
export type CapabilityConfig = z.infer<typeof CapabilityConfigSchema>;

export const KeypairSignerSchema = z.object({ type: z.literal('keypair'), keypairPath: FilePath }).strict();

/**
 * Kurumun imzacısı: yerel keypair ya da imzasız tx dışa verme (MCP paketindeki ilke: anahtar sunucuda değil,
 * kurumun cüzdanındadır). İmzasız kipte delegasyon her çağrıda sıradaki tx'i döner ve `outboxDir` verilmişse oraya
 * yazar; duty'ler zamana bağlı olduğu için keypair ister.
 */
export const InstitutionSignerSchema = z.discriminatedUnion('type', [
  KeypairSignerSchema,
  z.object({ type: z.literal('unsigned'), publicKey: Address, outboxDir: FilePath.optional() }).strict(),
]);
export type InstitutionSignerConfig = z.infer<typeof InstitutionSignerSchema>;

export const AllowedAgentSchema = z
  .object({
    agentRecord: Address,
    /** Verilirse bu agent'a yalnızca bu kategorilerde iş açılır (politikanın izinli kategorileri ayrıca geçerli). */
    categories: z.array(PolicyCategorySchema).min(1).optional(),
    /** Fonlanan iş bu A2A uç noktasına gönderilir; anahtar ortamdan. */
    a2a: z
      .object({
        url: HttpUrl,
        apiKeyEnv: EnvName,
        /** Yalnızca yerel geliştirme ve testler. */
        allowInsecureHttp: z.boolean().default(false),
      })
      .strict()
      .refine((a2a) => a2a.allowInsecureHttp || a2a.url.startsWith('https:'), {
        message: 'A2A uç noktası https olmalı (yerel deneme için allowInsecureHttp)',
        path: ['url'],
      })
      .optional(),
    /** Travel Rule kaydının yararlanıcı tarafı (IVMS101 alt kümesi); eşik üstü delegasyon bunu ister. */
    travelRule: z
      .object({ beneficiary: TravelRulePersonSchema, beneficiaryVasp: TravelRuleVaspSchema.nullable() })
      .strict()
      .optional(),
  })
  .strict();
export type AllowedAgent = z.infer<typeof AllowedAgentSchema>;

export const DelegationConfigSchema = z
  .object({
    /** Kurumun yerel politika belgesi (`PolicyDocument`, JSON ya da YAML); zincire çıkmaz. */
    policyFile: FilePath,
    /** Job'ların bağlanacağı zincirdeki `Policy` hesabı; verilirse release ispat ister. */
    policyAccount: Address.optional(),
    /** İstekte kategori yoksa kullanılan ödeme kategorisi. */
    defaultCategory: PolicyCategorySchema,
    allowedAgents: z
      .array(AllowedAgentSchema)
      .min(1)
      .refine((agents) => distinct(agents.map((agent) => agent.agentRecord)), { message: 'agent tekrar edemez' }),
    /** İstekte deadline yoksa şimdiden bu kadar saniye sonrası. */
    deadlineSecs: PositiveInt,
    challengePeriodSecs: PositiveInt,
    maxJobsPerDay: PositiveInt.default(20),
    /** Günlük harcama ve açılan job'ların defteri (dosya, 0600). */
    ledgerPath: FilePath,
    /**
     * Travel Rule kaydının kurum (originator) tarafı (IVMS101 alt kümesi, ADR 0017). Kayıt Square API'sinde şifreli
     * saklanır; yoksa eşik üstü delegasyon reddedilir.
     */
    travelRule: z
      .object({ originator: TravelRulePersonSchema, originatingVasp: TravelRuleVaspSchema.nullable() })
      .strict()
      .optional(),
  })
  .strict();
export type DelegationConfig = z.infer<typeof DelegationConfigSchema>;

export const DutiesConfigSchema = z
  .object({
    /** Kurumun job'larını tarama aralığı. */
    intervalMs: PositiveInt,
    /** Job adayları defterden; `api: true` ise Square API'sinden de (kurumun job'ları) okunur. */
    discovery: z.object({ api: z.boolean() }).strict(),
    policyWatch: z
      .object({
        /** 32 baytlık politika sırrı (salt'ların kaynağı, `derivePolicySalts`). */
        policySecretPath: FilePath,
        paymentCategory: PolicyCategorySchema,
        /** watchJobProof'un job başına kontrol aralığı. */
        intervalMs: PositiveInt,
        prover: z.object({ baseUrl: HttpsUrl, apiKeyEnv: EnvName, artifactVersion: z.string().min(1) }).strict(),
      })
      .strict()
      .optional(),
    crank: z.object({ executeResolution: z.boolean(), lapseDispute: z.boolean() }).strict().optional(),
  })
  .strict();
export type DutiesConfig = z.infer<typeof DutiesConfigSchema>;

export const HostedConfigSchema = z
  .object({
    version: z.literal(1),
    agent: z
      .object({
        name: z.string().min(1),
        description: z.string().min(1),
        version: z.string().min(1),
        provider: z
          .object({ organization: z.string().min(1), url: HttpsUrl })
          .strict()
          .optional(),
        publicUrl: HttpsUrl,
        /** Registry `agent_id`'si. */
        agentId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'agentId [A-Za-z0-9_-]{1,32} olmalı'),
        /** Açılışta kayıt: kart agent'ta (`self`), API'de (`api`) ya da kayıt yapılmaz (`none`). */
        register: z.enum(['self', 'api', 'none']),
        listen: z.object({ host: z.string().min(1), port: z.number().int().min(0).max(65_535) }).strict(),
        autoListClaim: z
          .object({ discountBps: z.number().int().min(1).max(9_999) })
          .strict()
          .optional(),
        /** A2A çağıranları: API anahtarının SHA-256'sı ve yetkili olduğu kurumlar. */
        callers: z
          .array(
            z
              .object({
                keySha256: z.string().regex(/^[0-9a-f]{64}$/, '64 küçük harf hex'),
                institutions: z.array(Address).min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    chain: z
      .object({
        rpcUrl: HttpUrl,
        commitment: z.enum(['processed', 'confirmed', 'finalized']),
        programIds: z.object({ registry: Address, policy: Address, verifier: Address, escrow: Address }).strict(),
        /** Mikro-lamport priority fee; verilmezse eklenmez. */
        computeUnitPrice: U64.optional(),
      })
      .strict(),
    /** Square API'si: teslimat yükleme, kart barındırma ve job keşfi. */
    api: z.object({ baseUrl: HttpUrl, apiKeyEnv: EnvName }).strict(),
    /** A2A görev deposu (Postgres; `@squaresdk/solana-a2a/prisma`). */
    store: z.object({ type: z.literal('postgres'), urlEnv: EnvName }).strict(),
    signers: z
      .object({
        /** Job'ların agent cüzdanı: accept_job, submit_work, list_claim. */
        agent: KeypairSignerSchema,
        /** Kurumun anahtarı: delegasyon ve duty'ler. */
        institution: InstitutionSignerSchema.optional(),
      })
      .strict(),
    mcp: z
      .object({
        servers: z.record(McpServerName, McpServerConfigSchema),
        maxConcurrency: PositiveInt,
        toolCacheTtlMs: z.number().int().min(0),
        requestTimeoutMs: PositiveInt,
        reconnect: z
          .object({
            maxAttempts: PositiveInt,
            backoffMs: z.number().int().min(0),
            maxBackoffMs: z.number().int().min(0),
          })
          .strict(),
      })
      .strict()
      .optional(),
    capabilities: z.array(CapabilityConfigSchema).min(1),
    delegation: DelegationConfigSchema.optional(),
    duties: DutiesConfigSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const ids = config.capabilities.map((capability) => capability.id);
    if (!distinct(ids)) issue(['capabilities'], 'capability kimlikleri tekrar edemez');
    const servers = new Set(Object.keys(config.mcp?.servers ?? {}));
    config.capabilities.forEach((capability, i) => {
      capability.tools.forEach((grant, j) => {
        if (!servers.has(grant.server)) {
          issue(['capabilities', i, 'tools', j, 'server'], `mcp.servers içinde ${grant.server} yok`);
        }
      });
      if (capability.delegation && !config.delegation) {
        issue(['capabilities', i, 'delegation'], 'delegasyon açık ama delegation bölümü yok');
      }
    });
    const keyFiles = [config.signers.agent, config.signers.institution].flatMap((signer) =>
      signer?.type === 'keypair' ? [signer.keypairPath] : [],
    );
    for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
      if (server.type !== 'stdio') continue;
      if (server.env && Object.hasOwn(server.env, 'SQUARE_SIGNER_KEYPAIR')) {
        issue(
          ['mcp', 'servers', name, 'env', 'SQUARE_SIGNER_KEYPAIR'],
          'MCP sunucusuna imza anahtarı verilemez: imza delegasyon kapısının dışında atılırdı',
        );
      }
      (server.args ?? []).forEach((arg, k) => {
        if (keyFiles.some((file) => arg.includes(file))) {
          issue(['mcp', 'servers', name, 'args', k], 'MCP sunucusuna agent ya da kurum keypair dosyası verilemez');
        }
      });
    }
    const institution = config.signers.institution;
    if (config.delegation && !institution) {
      issue(['signers', 'institution'], 'delegasyon kurumun imzacısını ister');
    }
    if (config.duties) {
      if (!config.duties.policyWatch && !config.duties.crank) {
        issue(['duties'], 'en az bir duty (policyWatch, crank) açılmalı');
      }
      if (institution?.type !== 'keypair') {
        issue(['signers', 'institution'], "duty'ler kurumun yerel keypair imzacısını ister (zamana bağlı tx'ler)");
      }
      if (config.duties.policyWatch && !config.delegation) {
        issue(['duties', 'policyWatch'], 'ispat bağlama kurumun politika belgesini ister (delegation.policyFile)');
      }
    }
  });
export type HostedConfig = z.infer<typeof HostedConfigSchema>;

/** Doğrulanmış yapılandırma ve dosyadan okunan yerel politika. Yollar yapılandırma dosyasına göre mutlaktır. */
export interface LoadedConfig {
  config: HostedConfig;
  /** Delegasyon ve ispat bağlama için kurumun politika belgesi. */
  policy: PolicyDocument | null;
  /** Yapılandırma dosyasının dizini. */
  baseDir: string;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join('.') : '(kök)'}: ${issue.message}`);
}

/** Uzantıya göre JSON ya da YAML. */
export function parseDocument(text: string, file: string): unknown {
  const extension = extname(file).toLowerCase();
  try {
    if (extension === '.json') return JSON.parse(text);
    if (extension === '.yaml' || extension === '.yml') return parseYaml(text);
  } catch (error) {
    throw new HostedConfigError(`${file} çözümlenemedi: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new HostedConfigError(`${file}: uzantı .json, .yaml ya da .yml olmalı`);
}

/** Ham değeri doğrular; geçersizse bütün sorunlarla `HostedConfigError`. */
export function parseHostedConfig(raw: unknown): HostedConfig {
  const parsed = HostedConfigSchema.safeParse(raw);
  if (!parsed.success) throw new HostedConfigError('hosted agent yapılandırması geçersiz', formatIssues(parsed.error));
  return parsed.data;
}

const absolute = (baseDir: string, path: string) => (isAbsolute(path) ? path : resolve(baseDir, path));

/** Yapılandırmadaki dosya yollarını yapılandırma dosyasının dizinine göre mutlak yapar. */
export function resolvePaths(config: HostedConfig, baseDir: string): HostedConfig {
  const at = (path: string) => absolute(baseDir, path);
  const institution = config.signers.institution;
  return {
    ...config,
    signers: {
      agent: { ...config.signers.agent, keypairPath: at(config.signers.agent.keypairPath) },
      ...(institution && {
        institution:
          institution.type === 'keypair'
            ? { ...institution, keypairPath: at(institution.keypairPath) }
            : { ...institution, ...(institution.outboxDir && { outboxDir: at(institution.outboxDir) }) },
      }),
    },
    ...(config.delegation && {
      delegation: {
        ...config.delegation,
        policyFile: at(config.delegation.policyFile),
        ledgerPath: at(config.delegation.ledgerPath),
      },
    }),
    ...(config.duties && {
      duties: {
        ...config.duties,
        ...(config.duties.policyWatch && {
          policyWatch: {
            ...config.duties.policyWatch,
            policySecretPath: at(config.duties.policyWatch.policySecretPath),
          },
        }),
      },
    }),
  };
}

/** Kurumun politika belgesi; devrenin kabul edemeyeceği politika burada reddedilir (`normalizePolicy`). */
export async function loadPolicyDocument(path: string): Promise<PolicyDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new HostedConfigError(
      `politika belgesi okunamadı: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = PolicyDocumentSchema.safeParse(parseDocument(text, path));
  if (!parsed.success) throw new HostedConfigError(`politika belgesi geçersiz (${path})`, formatIssues(parsed.error));
  normalizePolicy(parsed.data);
  return parsed.data;
}

/**
 * Yapılandırma dosyasını okur, doğrular, yolları çözer ve delegasyon açıksa politika belgesini yükler. Dosya ya
 * da politika geçersizse `HostedConfigError` fırlatır; çağıran hiçbir şey başlatmaz.
 */
export async function loadHostedConfig(file: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new HostedConfigError(`yapılandırma okunamadı: ${error instanceof Error ? error.message : String(error)}`);
  }
  const baseDir = dirname(resolve(file));
  const config = resolvePaths(parseHostedConfig(parseDocument(text, file)), baseDir);
  const policy = config.delegation ? await loadPolicyDocument(config.delegation.policyFile) : null;
  return { config, policy, baseDir };
}

/** Yapılandırmanın ortamdan okuduğu değişken adları. */
export function requiredEnv(config: HostedConfig): string[] {
  const names = new Set<string>([config.api.apiKeyEnv, config.store.urlEnv]);
  const collect = (values: Record<string, EnvValue> | undefined) => {
    for (const value of Object.values(values ?? {})) if (typeof value !== 'string') names.add(value.fromEnv);
  };
  for (const server of Object.values(config.mcp?.servers ?? {})) {
    collect(server.type === 'stdio' ? server.env : server.headers);
  }
  for (const agent of config.delegation?.allowedAgents ?? []) if (agent.a2a) names.add(agent.a2a.apiKeyEnv);
  if (config.duties?.policyWatch) names.add(config.duties.policyWatch.prover.apiKeyEnv);
  return [...names].sort();
}

/** Ortamda eksik değişken varsa adlarıyla reddeder (değerler hiçbir yere yazılmaz). */
export function assertEnv(config: HostedConfig, env: NodeJS.ProcessEnv): void {
  const missing = requiredEnv(config).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new HostedConfigError(
      'yapılandırmanın ortam değişkenleri eksik',
      missing.map((name) => `${name} tanımlı değil`),
    );
  }
}

/** `EnvValue`'yu çözer. */
export function envValue(value: EnvValue, env: NodeJS.ProcessEnv): string {
  if (typeof value === 'string') return value;
  const resolved = env[value.fromEnv];
  if (!resolved) throw new HostedConfigError(`${value.fromEnv} tanımlı değil`);
  return resolved;
}

/** Ortamdan zorunlu değer. */
export function envRequired(name: string, env: NodeJS.ProcessEnv): string {
  return envValue({ fromEnv: name }, env);
}
