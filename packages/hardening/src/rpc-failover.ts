// RPC failover: birden çok Solana RPC ucu arasında, ulaşılamayan, zaman aşımına uğrayan ya da 429 / 5xx
// dönen uç bir süre (`cooldownMs`) devre dışı kalır ve istek sıradakine gider. JSON-RPC hataları (HTTP
// 200) failover sebebi değildir; aynı hata her uçta tekrarlanır. web3.js'e `fetch` seçeneğiyle verilir:
// `new Connection(endpoints[0], { fetch: failover })`. WebSocket abonelikleri bu katmanın dışındadır.

export type FailoverReason = 'network' | 'timeout' | 'rate_limited' | 'server_error';

export interface FailoverFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Şu an tercih edilen uç. */
  endpoint(): string;
}

export interface FailoverOptions {
  endpoints: readonly string[];
  /** Tek bir denemenin süre sınırı. */
  timeoutMs: number;
  /** Hatalı ucun devre dışı kalma süresi. */
  cooldownMs: number;
  fetch?: typeof fetch;
  clock?: () => number;
  onFailover?: (event: { from: string; reason: FailoverReason; status?: number }) => void;
}

const normalize = (endpoint: string) => {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`RPC ucu http(s) değil: ${endpoint}`);
  return url.href;
};

export function createFailoverFetch(options: FailoverOptions): FailoverFetch {
  const endpoints = [...new Set(options.endpoints.map(normalize))];
  if (endpoints.length === 0) throw new Error('en az bir RPC ucu gerekli');
  if (!(options.timeoutMs > 0) || !(options.cooldownMs >= 0))
    throw new Error('timeoutMs pozitif, cooldownMs negatif olmayan olmalı');
  const send = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;
  let preferred = 0;
  let downUntil: readonly number[] = endpoints.map(() => 0);

  const markDown = (index: number, reason: FailoverReason, status?: number) => {
    downUntil = downUntil.map((until, i) => (i === index ? clock() + options.cooldownMs : until));
    options.onFailover?.({ from: endpoints[index]!, reason, ...(status === undefined ? {} : { status }) });
  };

  /** Sağlıklı uçlar tercih edilenden başlayarak, ardından devre dışı olanlar (son çare). */
  const order = () => {
    const now = clock();
    const rotated = endpoints.map((_, i) => (preferred + i) % endpoints.length);
    return [...rotated.filter((i) => downUntil[i]! <= now), ...rotated.filter((i) => downUntil[i]! > now)];
  };

  const target = (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.href;
    const base = endpoints.find((endpoint) => url.startsWith(endpoint) || `${url}/` === endpoint);
    if (base === undefined) throw new Error(`istek yapılandırılmış RPC uçlarından birine değil: ${url}`);
    return url.length >= base.length ? url.slice(base.length) : '';
  };

  const failover = (async (input: string | URL | Request, init: RequestInit = {}) => {
    // `Request` nesnesinin akış gövdesi yeniden gönderilemez; yalnızca gövdesiz olanı kabul edilir.
    if (input instanceof Request && input.body !== null) {
      throw new Error('failover isteğinin gövdesi yeniden gönderilebilir olmalı (dize ya da Uint8Array)');
    }
    const suffix = target(input instanceof Request ? input.url : input);
    if (input instanceof Request) init = { method: input.method, headers: input.headers, ...init };
    if (
      init.body !== undefined &&
      init.body !== null &&
      typeof init.body !== 'string' &&
      !(init.body instanceof Uint8Array)
    ) {
      throw new Error('failover isteğinin gövdesi yeniden gönderilebilir olmalı (dize ya da Uint8Array)');
    }
    const candidates = order();
    let lastError: unknown;
    for (const [attempt, index] of candidates.entries()) {
      const last = attempt === candidates.length - 1;
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      try {
        const response = await send(`${endpoints[index]}${suffix}`, { ...init, signal });
        if ((response.status === 429 || response.status >= 500) && !last) {
          markDown(index, response.status === 429 ? 'rate_limited' : 'server_error', response.status);
          continue;
        }
        if (response.status < 500 && response.status !== 429) preferred = index;
        return response;
      } catch (error) {
        // Çağıranın iptali failover sebebi değildir.
        if (init.signal?.aborted) throw error;
        lastError = error;
        markDown(index, timeout.aborted ? 'timeout' : 'network');
      }
    }
    throw lastError;
  }) as FailoverFetch;
  failover.endpoint = () => endpoints[preferred]!;
  return failover;
}
