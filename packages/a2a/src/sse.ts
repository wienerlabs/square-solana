// Server-Sent Events yazıcısı (spec §9.4.2): her olay bir `data:` satırında JSON-RPC yanıtıdır. Kalp
// atışı yorum satırıdır; yavaş tüketici (tampon sınırı aşılınca) ve azami süre akışı kapatır.
import type { ServerResponse } from 'node:http';

export interface SseOptions {
  heartbeatMs: number;
  maxDurationMs: number;
  /** Yazılmayı bekleyen bayt sınırı; aşılınca akış kapanır. */
  maxBufferedBytes: number;
}

export interface SseStream {
  /** Olayı yazar; akış kapalıysa false. */
  send(payload: unknown): boolean;
  close(): void;
  readonly closed: Promise<void>;
  isClosed(): boolean;
}

export function openSse(response: ServerResponse, options: SseOptions): SseStream {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  let open = true;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const heartbeat = setInterval(() => {
    if (open) response.write(': ping\n\n');
  }, options.heartbeatMs);
  const deadline = setTimeout(() => close(), options.maxDurationMs);

  function close() {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    response.end();
    resolveClosed();
  }

  response.on('close', close);

  return {
    send(payload) {
      if (!open) return false;
      if (response.writableLength > options.maxBufferedBytes) {
        close();
        return false;
      }
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    },
    close,
    closed,
    isClosed: () => !open,
  };
}
