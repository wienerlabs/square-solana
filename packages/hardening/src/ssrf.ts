// SSRF koruması: kullanıcının verdiği adrese (agent card URI'si, teslimat adresi, webhook hedefi) sunucudan
// istek atılırken iç ağa, bulut meta veri uçlarına (169.254.169.254) ve yerel servislere ulaşılamaz.
// - Adres yalnızca https (isteğe bağlı http), kullanıcı bilgisiz.
// - Ad çözümlenir; çözülen adreslerden biri bile özel / ayrılmış aralıktaysa istek reddedilir. Denetim
//   bağlantı anında, bağlanılan adres üzerinde yapılır (DNS rebinding: denetlenen ad başka bir adrese
//   bağlanamaz).
// - Yönlendirmeler elle izlenir, her adımda aynı denetimler; sayısı sınırlı.
// - Toplam süre ve yanıt boyutu sınırlı.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

export type SsrfFailure =
  'invalid_url' | 'scheme' | 'credentials' | 'private_address' | 'too_many_redirects' | 'too_large' | 'timeout';

export class SsrfError extends Error {
  constructor(
    readonly reason: SsrfFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Herkese açık olmayan aralıklar (RFC 6890 ve devamı). */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** IPv4 eşlemeli IPv6 adresinin (`::ffff:a.b.c.d` ya da `::ffff:aabb:ccdd`) IPv4 kısmı. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1]!;
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** Adres herkese açık mı (özel, döngü, yerel bağlantı, ayrılmış ya da çoklu yayın değil). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const v4 = mappedIpv4(address);
    return v4 ? isPublicAddress(v4) : !BLOCKED.check(address, 'ipv6');
  }
  return false;
}

export interface SafeUrlPolicy {
  /** http'ye izin (yalnızca geliştirme); varsayılan yalnızca https. */
  readonly allowHttp: boolean;
  /** Özel adreslere izin (yalnızca iç servis çağrıları ve testler). */
  readonly allowPrivateAddresses: boolean;
}

/** Adresin sözdizimi denetimi; ad çözümlemesi bağlantıdadır. */
export function assertSafeUrl(input: string | URL, policy: SafeUrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfError('invalid_url', 'adres geçersiz');
  }
  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new SsrfError('scheme', `şema kabul edilmiyor: ${url.protocol}`);
  }
  if (url.username || url.password) throw new SsrfError('credentials', 'adreste kullanıcı bilgisi olamaz');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !policy.allowPrivateAddresses && !isPublicAddress(host)) {
    throw new SsrfError('private_address', 'adres herkese açık değil');
  }
  return url;
}

type LookupFunction = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** Bağlantı anındaki ad çözümleme: çözülen bütün adresler herkese açık olmalı; bağlanılan adres denetlenendir. */
export function guardedLookup(policy: SafeUrlPolicy, resolve: LookupFunction = dnsLookup as LookupFunction) {
  return (
    hostname: string,
    options: { family?: number | string; all?: boolean },
    callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    resolve(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const usable = addresses.filter(
        (entry) => !options.family || options.family === entry.family || options.family === `IPv${entry.family}`,
      );
      const blocked = !policy.allowPrivateAddresses && usable.some((entry) => !isPublicAddress(entry.address));
      if (usable.length === 0 || blocked) {
        return callback(
          new SsrfError('private_address', `${hostname} herkese açık olmayan bir adrese çözülüyor`),
          '',
          0,
        );
      }
      if (options.all) return callback(null, usable);
      return callback(null, usable[0]!.address, usable[0]!.family);
    });
  };
}

export interface SafeFetchOptions extends SafeUrlPolicy {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly lookup?: LookupFunction;
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Son yönlendirmeden sonraki adres. */
  readonly url: string;
  readonly body: Uint8Array;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SsrfError('too_large', 'yanıt boyut sınırını aşıyor');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new SsrfError('too_large', 'yanıt boyut sınırını aşıyor');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Kullanıcının verdiği adrese güvenli istek. Gövde dize ya da Uint8Array olmalıdır. */
export function createSafeFetch(
  options: SafeFetchOptions,
): (
  input: string | URL,
  init?: { method?: string; headers?: Readonly<Record<string, string>>; body?: string | Uint8Array },
) => Promise<SafeResponse> {
  if (!(options.timeoutMs > 0) || !(options.maxBytes > 0) || !(options.maxRedirects >= 0)) {
    throw new Error('timeoutMs ve maxBytes pozitif, maxRedirects negatif olmayan olmalı');
  }
  const dispatcher: Dispatcher = new Agent({ connect: { lookup: guardedLookup(options, options.lookup) } });
  return async (input, init = {}) => {
    const signal = AbortSignal.timeout(options.timeoutMs);
    let url = assertSafeUrl(input, options);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    try {
      for (let redirects = 0; ; redirects += 1) {
        const response = (await undiciFetch(url, {
          method,
          headers: init.headers,
          body,
          redirect: 'manual',
          signal,
          dispatcher,
        })) as unknown as Response;
        const location = response.headers.get('location');
        if (!REDIRECTS.has(response.status) || !location) {
          return {
            status: response.status,
            headers: response.headers,
            url: url.href,
            body: await readLimited(response, options.maxBytes),
          };
        }
        await response.body?.cancel();
        if (redirects >= options.maxRedirects) throw new SsrfError('too_many_redirects', 'yönlendirme sınırı aşıldı');
        url = assertSafeUrl(new URL(location, url), options);
        // 303 her zaman GET; 301 / 302 POST'u GET'e çevirir (tarayıcı davranışı).
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
      }
    } catch (error) {
      if (signal.aborted) throw new SsrfError('timeout', 'istek süre sınırını aştı');
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof SsrfError) throw cause;
      throw error;
    }
  };
}
