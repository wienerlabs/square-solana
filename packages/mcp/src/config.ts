// Sunucunun yapılandırması: her değer ortamdan gelir ve açılışta doğrulanır; varsayılan değer yoktur. Okuma araçları
// zincirden okur (RPC ve program kimlikleri; adlar web ve db ile aynı), barındırılan bir API gerektirmez.
// İsteğe bağlı olanlar:
// - `SQUARE_MCP_KEYPAIR`: imzacının keypair dosyası. Verilirse yazma araçları bu anahtarın rolündeki tx'i
//   imzalayıp gönderir; verilmezse imzasız tx döner ve imza istemcide atılır.
// - `SQUARE_MCP_LOOKUP_TABLE`: Square ALT'ı (BC-28); `SQUARE_MCP_COMPUTE_UNIT_PRICE`: priority fee.
// - `SQUARE_API_URL` + `SQUARE_API_KEY` (`deliveries:write`): teslim edilen içeriğin Square API'ye yüklenmesi.
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { SquareProgramIds } from '@squaresdk/solana-sdk';
import { Cluster } from '@squaresdk/solana-types';
import { z } from 'zod';

export const ENV = {
  cluster: 'SQUARE_MCP_CLUSTER',
  rpcUrl: 'SQUARE_MCP_RPC_URL',
  timeoutMs: 'SQUARE_MCP_TIMEOUT_MS',
  cardMaxBytes: 'SQUARE_MCP_CARD_MAX_BYTES',
  keypair: 'SQUARE_MCP_KEYPAIR',
  lookupTable: 'SQUARE_MCP_LOOKUP_TABLE',
  computeUnitPrice: 'SQUARE_MCP_COMPUTE_UNIT_PRICE',
  apiUrl: 'SQUARE_API_URL',
  apiKey: 'SQUARE_API_KEY',
} as const;

const PROGRAM_ENV = {
  registry: 'SQUARE_PROGRAM_ID_REGISTRY',
  policy: 'SQUARE_PROGRAM_ID_POLICY',
  verifier: 'SQUARE_PROGRAM_ID_VERIFIER',
  escrow: 'SQUARE_PROGRAM_ID_ESCROW',
} as const satisfies Record<keyof SquareProgramIds, string>;

export interface SquareMcpConfig {
  readonly cluster: Cluster;
  readonly rpcUrl: string;
  readonly programIds: SquareProgramIds;
  /** RPC dışı istekler (agent card, API) için zaman aşımı. */
  readonly timeoutMs: number;
  /** İndirilen agent card'ın üst sınırı (bayt). */
  readonly cardMaxBytes: number;
  readonly signer: Keypair | null;
  readonly lookupTable: PublicKey | null;
  readonly computeUnitPrice: bigint | null;
  readonly api: { readonly url: string; readonly apiKey: string } | null;
}

const text = z.string().trim().min(1);
const positiveInt = text.transform(Number).pipe(z.number().int().positive());
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

function address(value: string, name: string, problems: string[]): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    problems.push(`${name}: base58 Solana adresi bekleniyor`);
    return null;
  }
}

/** Keypair dosyası (solana-keygen biçimi). İçerik hata mesajına yazılmaz. */
function keypair(path: string, readFile: (path: string) => string, problems: string[]): Keypair | null {
  try {
    const bytes = JSON.parse(readFile(path)) as unknown;
    if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error('64 baytlık dizi değil');
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'JSON değil' : (error as Error).message;
    problems.push(`${ENV.keypair}: keypair dosyası okunamadı (${reason})`);
    return null;
  }
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): SquareMcpConfig {
  const schema = z.object({
    [ENV.cluster]: Cluster,
    [ENV.rpcUrl]: z.url({ protocol: /^https?$/ }),
    [ENV.timeoutMs]: positiveInt,
    [ENV.cardMaxBytes]: positiveInt,
    [ENV.keypair]: optional(text),
    [ENV.lookupTable]: optional(text),
    [ENV.computeUnitPrice]: optional(text.regex(/^(0|[1-9][0-9]{0,19})$/, 'u64 ondalık bekleniyor').transform(BigInt)),
    [ENV.apiUrl]: optional(z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ''))),
    [ENV.apiKey]: optional(text),
    ...Object.fromEntries(Object.values(PROGRAM_ENV).map((name) => [name, text])),
  });
  const parsed = schema.safeParse(env);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  if (!parsed.success) throw new Error(`Geçersiz Square MCP ortamı:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  const e = parsed.data as Record<string, unknown>;

  const programIds = Object.fromEntries(
    Object.entries(PROGRAM_ENV).map(([program, name]) => [program, address(e[name] as string, name, problems)]),
  ) as Record<keyof SquareProgramIds, PublicKey | null>;
  const lookupTable = e[ENV.lookupTable] ? address(e[ENV.lookupTable] as string, ENV.lookupTable, problems) : null;
  const signer = e[ENV.keypair] ? keypair(e[ENV.keypair] as string, readFile, problems) : null;
  const apiUrl = e[ENV.apiUrl] as string | undefined;
  const apiKey = e[ENV.apiKey] as string | undefined;
  if ((apiUrl === undefined) !== (apiKey === undefined)) {
    problems.push(`${ENV.apiUrl} ve ${ENV.apiKey} birlikte verilir`);
  }
  if (problems.length > 0) {
    throw new Error(`Geçersiz Square MCP ortamı:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return Object.freeze({
    cluster: e[ENV.cluster] as Cluster,
    rpcUrl: e[ENV.rpcUrl] as string,
    programIds: programIds as SquareProgramIds,
    timeoutMs: e[ENV.timeoutMs] as number,
    cardMaxBytes: e[ENV.cardMaxBytes] as number,
    signer,
    lookupTable,
    computeUnitPrice: (e[ENV.computeUnitPrice] as bigint | undefined) ?? null,
    api: apiUrl && apiKey ? Object.freeze({ url: apiUrl, apiKey }) : null,
  });
}
