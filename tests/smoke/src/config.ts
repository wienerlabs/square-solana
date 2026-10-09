// Küme yapılandırması (BC-30, BC-31): RPC, program kimlikleri, settlement mint'i, Square ALT'ı, rol
// anahtarlarının DOSYA YOLLARI ve init / smoke değerleri. JSON dosyasıdır, açılışta zod ile doğrulanır;
// varsayılan değer yoktur. Anahtar içerikleri yapılandırmada ve depoda bulunmaz: göreli yollar yapılandırma
// dosyasının dizinine göre çözülür, depo içindeki bir yol reddedilir (`keys.ts`). RPC adresi bir API anahtarı
// taşıyabildiği için `SMOKE_RPC_URL` ortam değişkeniyle de verilebilir; verilirse dosyadakini ezer.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const U64_MAX = 2n ** 64n - 1n;
const I64_MAX = 2n ** 63n - 1n;
/** ADR 0013: keeper ücreti escrow tutarının en fazla %1'i. */
export const MAX_KEEPER_FEE_BPS = 100;
/** ADR 0016: arbitrator seti en fazla 7 üye. */
export const MAX_ARBITRATORS = 7;

const isAddress = (value: string) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
};

export const Address = z
  .string()
  .refine(isAddress, { message: 'base58 Solana adresi bekleniyor' })
  .transform((value) => new PublicKey(value));

/** u64: JSON'da sayı güvenli tamsayı sınırını aşabildiği için ondalık dize de kabul edilir. */
export const U64 = z
  .union([z.string().regex(/^\d+$/, 'ondalık tamsayı bekleniyor'), z.number().int().nonnegative()])
  .transform((value) => BigInt(value))
  .refine((value) => value <= U64_MAX, { message: 'u64 aralığı dışında' });

export const PositiveSecs = z.number().int().positive();
export const KeyPath = z.string().trim().min(1);

const ProgramIdsSchema = z.object({
  registry: Address,
  policy: Address,
  verifier: Address,
  escrow: Address,
});

/** `EscrowParams` (program arayüzü §10.4); kurallar `config_rules.rs` ile aynı (ADR 0013, ADR 0016). */
export const EscrowParamsSchema = z
  .object({
    minChallengePeriod: U64,
    maxChallengePeriod: U64,
    minBondBps: z.number().int().min(0).max(10_000),
    minBondAbsolute: U64,
    keeperFeeBps: z.number().int().min(0).max(MAX_KEEPER_FEE_BPS),
    proofTimeoutSecs: z.number().int().min(0),
    disputeTimeoutSecs: PositiveSecs,
    travelRuleThreshold: U64,
  })
  .refine(
    (p) => p.minChallengePeriod > 0n && p.minChallengePeriod <= p.maxChallengePeriod && p.maxChallengePeriod <= I64_MAX,
    { message: 'challenge sınırları 0 < min ≤ max ≤ i64 olmalı', path: ['maxChallengePeriod'] },
  );
export type EscrowParamsInput = z.infer<typeof EscrowParamsSchema>;

const ArbitratorsSchema = z
  .object({
    arbitrators: z.array(Address).min(2).max(MAX_ARBITRATORS),
    threshold: z.number().int().min(2),
  })
  .refine((a) => new Set(a.arbitrators.map((key) => key.toBase58())).size === a.arbitrators.length, {
    message: 'arbitrator tekrar edemez',
    path: ['arbitrators'],
  })
  .refine((a) => a.arbitrators.every((key) => !key.equals(PublicKey.default)), {
    message: 'boş anahtar arbitrator olamaz',
    path: ['arbitrators'],
  })
  .refine((a) => a.threshold <= a.arbitrators.length, {
    message: 'eşik 2 ≤ M ≤ N olmalı',
    path: ['threshold'],
  });

/** BC-30 init değerleri (runbook adım 5). */
const InitSchema = z.object({
  registry: z.object({ screenerAuthority: Address, screeningTtlSecs: PositiveSecs }),
  verifier: z.object({ mppAuthority: Address }),
  escrow: ArbitratorsSchema.and(z.object({ params: EscrowParamsSchema })),
  /** Upgrade authority'nin beklenen Squads v4 vault'u; verilirse zincirdeki authority onunla karşılaştırılır. */
  squads: z.object({ multisig: Address, vaultIndex: z.number().int().min(0).max(255) }).optional(),
});

/** BC-31 smoke değerleri. Üç iş fonlanır: ana akış, ispat-ret ve ispat-yok varyantları. */
const SmokeSchema = z
  .object({
    /** Her işin escrow tutarı (settlement mint atomik birimi). */
    jobAmount: U64.refine((value) => value > 0n, { message: 'tutar sıfır olamaz' }),
    /** Alacağın satış fiyatı: 0 < fiyat < tutar. */
    claimPrice: U64,
    /** İşlerin challenge süresi; config'teki sınırlar içinde olmalı (zincirde denetlenir). */
    challengePeriodSecs: PositiveSecs,
    /** Teslim için süre: `deadline = şimdi + deadlineSecs`. */
    deadlineSecs: PositiveSecs,
    /** Politikanın izin verdiği ve işin beyan ettiği ödeme kategorisi (1–32 bayt). */
    paymentCategory: z.string().min(1).max(32),
  })
  .refine((s) => s.claimPrice > 0n && s.claimPrice < s.jobAmount, {
    message: 'alacak fiyatı 0 < fiyat < tutar olmalı',
    path: ['claimPrice'],
  })
  .refine((s) => s.deadlineSecs > s.challengePeriodSecs, {
    message: 'deadline challenge süresinden uzun olmalı',
    path: ['deadlineSecs'],
  });

export const ClusterConfigSchema = z.object({
  /** Kümenin adı; rapor `docs/deploy/smoke-<cluster>.md`'ye yazılır. */
  cluster: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'küçük harf, rakam ve tire'),
  rpcUrl: z.url({ protocol: /^https?$/ }),
  commitment: z.enum(['confirmed', 'finalized']),
  programIds: ProgramIdsSchema,
  /** `EscrowConfig.settlement_mint` (devnet: Circle devnet USDC). */
  settlementMint: Address,
  /** Square ALT'ı; yoksa `init` açar ve adresini yazdırır. */
  lookupTable: Address.optional(),
  /** Öncelik ücreti (micro-lamport / CU); verilmezse eklenmez. */
  computeUnitPrice: z.number().int().min(0).optional(),
  keys: z.object({
    /** Ücretleri ve rol imzacısı olmayan hesapların rentini öder. */
    payer: KeyPath,
    /** Programların upgrade authority'si yerel bir anahtarsa (localnet); Squads vault'unda verilmez. */
    admin: KeyPath.optional(),
    /** ALT'ın authority'si; verilmezse payer. */
    lookupTableAuthority: KeyPath.optional(),
    screener: KeyPath.optional(),
    institution: KeyPath.optional(),
    agent: KeyPath.optional(),
    buyer: KeyPath.optional(),
    keeper: KeyPath.optional(),
    /**
     * `VerifierConfig.mpp_authority`'nin anahtarı (BC-37). Verilirse fiat varyantı koşar: smoke Stripe ödemesi
     * yapmaz, makbuz commitment'ı koşudan türetilir ve bu anahtarla imzalanır. Gerçek Stripe akışı BE-25'tedir.
     */
    mppAuthority: KeyPath.optional(),
  }),
  init: InitSchema.optional(),
  smoke: SmokeSchema.optional(),
});

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;
export type InitValues = NonNullable<ClusterConfig['init']>;
export type SmokeValues = NonNullable<ClusterConfig['smoke']>;
export type KeyRole = keyof ClusterConfig['keys'];

/** Ham JSON'u doğrular; göreli anahtar yollarını `baseDir`'e göre çözer. */
export function parseClusterConfig(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv = {}): ClusterConfig {
  const rpcOverride = env.SMOKE_RPC_URL?.trim();
  const input =
    rpcOverride && typeof raw === 'object' && raw !== null ? { ...(raw as object), rpcUrl: rpcOverride } : raw;
  const result = ClusterConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(kök)'}: ${issue.message}`);
    throw new Error(`küme yapılandırması geçersiz:\n${issues.join('\n')}`);
  }
  const keys = Object.fromEntries(
    Object.entries(result.data.keys).map(([role, path]) => [
      role,
      path === undefined ? undefined : isAbsolute(path) ? path : resolve(baseDir, path),
    ]),
  ) as ClusterConfig['keys'];
  return { ...result.data, keys };
}

export function loadClusterConfig(path: string, env: NodeJS.ProcessEnv = process.env): ClusterConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`küme yapılandırması okunamadı (${path}): ${(error as Error).message}`, { cause: error });
  }
  return parseClusterConfig(raw, dirname(resolve(path)), env);
}

/** Komutun gerektirdiği bölümü ve anahtarları ister; eksikse hangisinin eksik olduğunu söyler. */
export function requireSection<K extends 'init' | 'smoke'>(
  config: ClusterConfig,
  section: K,
  roles: readonly KeyRole[],
): NonNullable<ClusterConfig[K]> {
  const value = config[section];
  if (!value) throw new Error(`yapılandırmada "${section}" bölümü yok`);
  const missing = roles.filter((role) => config.keys[role] === undefined);
  if (missing.length > 0) throw new Error(`"${section}" için anahtar yolları eksik: ${missing.join(', ')}`);
  return value as NonNullable<ClusterConfig[K]>;
}
