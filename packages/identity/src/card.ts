// Agent card indirme ve bütünlük sınıflandırması (Solana profili §5.5). Hash, taşıma kodlaması
// (gzip vb.) açıldıktan sonra gelen baytların tamamı üzerinde hesaplanır.
import { sha256 } from '@noble/hashes/sha2';
import { AgentCardSchema, type AgentCard } from '@squaresdk/solana-types';
import type { AgentCardStatus, CardFetchOptions, ResolutionWarning, ResolvedCard } from './types.js';

/** URI'nin şeması, küçük harf; URI değilse null. */
export function uriScheme(uri: string): string | null {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  return match ? match[1]!.toLowerCase() : null;
}

/** İndirilecek https adresi: https URI'nin kendisi ya da ipfs URI'nin ağ geçidindeki karşılığı. */
function httpsLocation(uri: string, gateway: string | undefined): string | null {
  const scheme = uriScheme(uri);
  if (scheme === 'https') return uri;
  if (scheme === 'ipfs' && gateway) {
    if (uriScheme(gateway) !== 'https') throw new Error(`ipfs ağ geçidi https olmalı: ${gateway}`);
    return `${gateway.replace(/\/+$/, '')}/${uri.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  }
  return null;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  chunks.reduce((offset, chunk) => (bytes.set(chunk, offset), offset + chunk.length), 0);
  return bytes;
}

/**
 * Kartın baytları; indirilemezse ya da şema desteklenmiyorsa null. Yalnızca https (ipfs, ayarlanmış
 * https ağ geçidi üzerinden); yönlendirme izlenmez (SSRF); boyut ve süre sınırlı.
 */
export async function fetchCardBytes(uri: string, options: CardFetchOptions): Promise<Uint8Array | null> {
  const location = httpsLocation(uri, options.ipfsGateway);
  if (!location) return null;
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(location, { redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs) });
    if (!response.ok) return null;
    return await readLimited(response, options.maxBytes);
  } catch {
    // Ağ hatası, zaman aşımı ya da yönlendirme: kart "unavailable" olur ve uyarıyla raporlanır (§5.5).
    return null;
  }
}

export function verifyAgentCardHash(bytes: Uint8Array, expectedHash: Uint8Array): boolean {
  const actual = sha256(bytes);
  return actual.length === expectedHash.length && actual.every((byte, i) => byte === expectedHash[i]);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Çözüm için geçerlilik (§5.5): hepsi ya da hiçbiri. `registrations`'tan eşlenemeyenler sayılır. */
function asResolvedCard(bytes: Uint8Array): { card: ResolvedCard; malformedRegistrations: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const { services, active, registrations } = parsed;
  if (active !== undefined && typeof active !== 'boolean') return null;
  if (services !== undefined) {
    if (!Array.isArray(services)) return null;
    if (!services.every((s) => isObject(s) && typeof s.name === 'string' && typeof s.endpoint === 'string'))
      return null;
  }
  const list: unknown[] = Array.isArray(registrations) ? registrations : [];
  const wellTyped = list.filter(
    (r): r is { agentRegistry: string; agentId: string | number } =>
      isObject(r) &&
      typeof r.agentRegistry === 'string' &&
      (typeof r.agentId === 'string' || typeof r.agentId === 'number'),
  );
  const card: ResolvedCard = {
    ...(services !== undefined && {
      services: (services as { name: string; endpoint: string }[]).map(({ name, endpoint }) => ({ name, endpoint })),
    }),
    ...(active !== undefined && { active }),
    ...(wellTyped.length > 0 && {
      registrations: wellTyped.map((r) => ({ agentRegistry: r.agentRegistry, agentId: String(r.agentId) })),
    }),
  };
  return { card, malformedRegistrations: list.length - wellTyped.length };
}

export interface CardOutcome {
  status: AgentCardStatus;
  card: ResolvedCard | null;
  /** `registrations`'ta tipi bozuk olduğu için okunmayan girdi sayısı. */
  malformedRegistrations: number;
  warning?: ResolutionWarning;
}

/** Kartı indirir ve §5.5 tablosuna göre sınıflandırır; hiçbir sonuç çözüm hatası değildir. */
export async function classifyCard(
  uri: string,
  expectedHash: Uint8Array,
  options: CardFetchOptions,
): Promise<CardOutcome> {
  if (uri === '') return { status: 'absent', card: null, malformedRegistrations: 0 };
  const bytes = await fetchCardBytes(uri, options);
  if (!bytes) {
    return {
      status: 'unavailable',
      card: null,
      malformedRegistrations: 0,
      warning: { code: 'agentCardUnreachable', message: `${uri} could not be dereferenced` },
    };
  }
  if (!verifyAgentCardHash(bytes, expectedHash)) {
    return {
      status: 'unverified',
      card: null,
      malformedRegistrations: 0,
      warning: { code: 'agentCardHashMismatch', message: `SHA-256 of ${uri} does not match agent_card_hash` },
    };
  }
  const resolved = asResolvedCard(bytes);
  if (!resolved) {
    return {
      status: 'invalid',
      card: null,
      malformedRegistrations: 0,
      warning: { code: 'agentCardInvalid', message: `${uri} matches agent_card_hash but is not a valid agent card` },
    };
  }
  return { status: 'verified', ...resolved };
}

/** Square kart şemasına (`AgentCardSchema`) uyan kartı indirir; uymuyorsa ya da indirilemezse fırlatır. */
export async function fetchAgentCard(
  uri: string,
  options: CardFetchOptions,
): Promise<{ card: AgentCard; bytes: Uint8Array }> {
  const bytes = await fetchCardBytes(uri, options);
  if (!bytes) throw new Error(`${uri} could not be dereferenced`);
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return { card: AgentCardSchema.parse(parsed), bytes };
}
