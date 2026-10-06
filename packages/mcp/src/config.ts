// Square MCP sunucusunun yapılandırması. Değerler ortamdan okunur ve açılışta doğrulanır; dağıtıma bağlı
// hiçbir değerin (API adresi, ağ, zaman aşımı, RPC, program kimliği, port) varsayılanı yoktur.
//
// Kipler:
// - Okuma: `SQUARE_API_URL`, `SQUARE_NETWORK`, `SQUARE_TIMEOUT_MS` zorunlu; `SQUARE_API_KEY` verilirse okuma
//   istekleri de anahtarla gider (`read` kapsamı).
// - Yazma: `SQUARE_RPC_URL` ve `SQUARE_ESCROW_PROGRAM_ID` birlikte verilir ve `SQUARE_API_KEY` ister
//   (`tx:prepare`, teslimat için `deliveries:write`). Sunucu özel anahtar tutmaz; tx imzasız döner.
// - Yerel imzalayıcı: `SQUARE_SIGNER_KEYPAIR` (keypair JSON dosyasının yolu) yalnızca yazma kipinde ve yalnızca
//   stdio taşımasında kabul edilir; açıkça verilmedikçe kapalıdır.
import { PublicKey } from '@solana/web3.js';

export interface WriteConfig {
  /** Solana JSON-RPC ucu: imzalı tx'in gönderimi, settlement mint'i ve job hesabının okunması. */
  rpcUrl: string;
  /** square_escrow program kimliği (job PDA'sı ve EscrowConfig). */
  escrowProgramId: string;
}

export interface SquareMcpConfig {
  /** Square REST API'sinin kök adresi (apps/api). */
  apiUrl: string;
  /** Agent'a bildirilen ağ etiketi (ör. devnet). */
  network: string;
  /** API ve RPC isteklerinin zaman aşımı; onay beklemesi de bu süreyle sınırlıdır. */
  timeoutMs: number;
  /** `X-API-Key`; yazma kipinde zorunlu. */
  apiKey: string | null;
  /** Yazma kipi kapalıysa null. */
  write: WriteConfig | null;
  /** Yerel imzalayıcı keypair dosyası; verilmemişse null (varsayılan). */
  signerKeypairPath: string | null;
}

export interface HttpConfig {
  host: string;
  port: number;
  /** Verilirse DNS rebinding koruması açılır ve yalnızca bu `Host` değerleri kabul edilir. */
  allowedHosts: string[] | null;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const optional = (env: Env, name: string): string | null => {
  const value = env[name]?.trim();
  return value ? value : null;
};

const required = (env: Env, name: string): string => {
  const value = optional(env, name);
  if (value === null) throw new ConfigError(`${name} ortam değişkeni zorunlu`);
  return value;
};

const positiveInt = (name: string, raw: string, max = Number.MAX_SAFE_INTEGER): number => {
  const value = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new ConfigError(`${name} 1–${max} aralığında tamsayı olmalı: ${raw}`);
  }
  return value;
};

const httpUrl = (name: string, raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} geçerli bir URL değil: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError(`${name} http(s) olmalı: ${raw}`);
  return url.toString().replace(/\/+$/, '');
};

export function loadConfig(env: Env = process.env): SquareMcpConfig {
  const apiUrl = httpUrl('SQUARE_API_URL', required(env, 'SQUARE_API_URL'));
  const network = required(env, 'SQUARE_NETWORK');
  const timeoutMs = positiveInt('SQUARE_TIMEOUT_MS', required(env, 'SQUARE_TIMEOUT_MS'));
  const apiKey = optional(env, 'SQUARE_API_KEY');

  const rpcUrl = optional(env, 'SQUARE_RPC_URL');
  const escrowProgramId = optional(env, 'SQUARE_ESCROW_PROGRAM_ID');
  let write: WriteConfig | null = null;
  if (rpcUrl !== null || escrowProgramId !== null) {
    if (rpcUrl === null || escrowProgramId === null) {
      throw new ConfigError('yazma kipi için SQUARE_RPC_URL ve SQUARE_ESCROW_PROGRAM_ID birlikte verilmeli');
    }
    if (apiKey === null)
      throw new ConfigError('yazma kipi SQUARE_API_KEY ister (kapsam: tx:prepare, deliveries:write)');
    try {
      new PublicKey(escrowProgramId);
    } catch {
      throw new ConfigError(`SQUARE_ESCROW_PROGRAM_ID geçerli bir adres değil: ${escrowProgramId}`);
    }
    write = { rpcUrl: httpUrl('SQUARE_RPC_URL', rpcUrl), escrowProgramId };
  }

  const signerKeypairPath = optional(env, 'SQUARE_SIGNER_KEYPAIR');
  if (signerKeypairPath !== null && write === null) {
    throw new ConfigError(
      'SQUARE_SIGNER_KEYPAIR yalnızca yazma kipinde (SQUARE_RPC_URL, SQUARE_ESCROW_PROGRAM_ID) geçerli',
    );
  }

  return { apiUrl, network, timeoutMs, apiKey, write, signerKeypairPath };
}

export function loadHttpConfig(env: Env = process.env): HttpConfig {
  const host = required(env, 'SQUARE_MCP_HTTP_HOST');
  const port = positiveInt('SQUARE_MCP_HTTP_PORT', required(env, 'SQUARE_MCP_HTTP_PORT'), 65_535);
  const hosts = optional(env, 'SQUARE_MCP_ALLOWED_HOSTS');
  const allowedHosts = hosts
    ? hosts
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : null;
  if (allowedHosts !== null && allowedHosts.length === 0) {
    throw new ConfigError('SQUARE_MCP_ALLOWED_HOSTS en az bir değer içermeli');
  }
  return { host, port, allowedHosts };
}
