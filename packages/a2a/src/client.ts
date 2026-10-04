// A2A v1.0 JSON-RPC istemcisi (spec §9): yanıtlar zod ile doğrulanır, akışlar SSE olarak okunur.
// Yönlendirme izlenmez, yanıt boyutu sınırlıdır; varsayılan olarak yalnızca https uç noktası kabul edilir.
import { randomUUID } from 'node:crypto';
import {
  A2A_PROTOCOL_VERSION,
  JsonRpcResponseSchema,
  ListTasksResponseSchema,
  SendMessageResponseSchema,
  StreamResponseSchema,
  TaskSchema,
  type CancelTaskRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type StreamResponse,
  type SubscribeToTaskRequest,
  type Task,
} from '@squaresdk/solana-types';
import type { z } from 'zod';
import { A2aError, type ErrorDetail } from './errors.js';

export interface A2aClientOptions {
  /** Agent kartındaki A2A uç noktası. */
  url: string;
  /**
   * İstek süresi. Akışta sunucudan veri (olay ya da kalp atışı) gelmeden geçebilecek en uzun süredir;
   * tüketicinin olayı işleme süresi sayılmaz. Akışın toplam süresi `RequestOptions.signal` ile sınırlanır.
   */
  timeoutMs: number;
  /** Her isteğe eklenen başlıklar (ör. kimlik doğrulama). */
  headers?: Readonly<Record<string, string>> | (() => Promise<Readonly<Record<string, string>>>);
  /** Yalnızca yerel geliştirme ve testler: http uç noktasına izin verir. */
  allowInsecureHttp?: boolean;
  /** Bir yanıtın ya da tek bir akış olayının en büyük boyutu (bayt). */
  maxResponseBytes?: number;
  /**
   * Ağ katmanı. Uç nokta güvenilmeyen bir agent kartından geliyorsa iç ağ ve meta veri adreslerini
   * engelleyen (SSRF korumalı) bir fetch verilmelidir (BE-13); varsayılan fetch adresi denetlemez.
   */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** İsteği ya da akışı keser; yalnız kalp atışı gelen bir akış da bununla durdurulur. */
  signal?: AbortSignal;
}

export interface A2aClient {
  sendMessage(params: SendMessageRequest, options?: RequestOptions): Promise<SendMessageResponse>;
  sendStreamingMessage(params: SendMessageRequest, options?: RequestOptions): AsyncIterable<StreamResponse>;
  getTask(params: GetTaskRequest, options?: RequestOptions): Promise<Task>;
  listTasks(params: ListTasksRequest, options?: RequestOptions): Promise<ListTasksResponse>;
  cancelTask(params: CancelTaskRequest, options?: RequestOptions): Promise<Task>;
  subscribeToTask(params: SubscribeToTaskRequest, options?: RequestOptions): AsyncIterable<StreamResponse>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const INVALID_RESPONSE = -32006;
const MAX_ERROR_MESSAGE = 1024;

const invalid = (detail: string) => new A2aError(INVALID_RESPONSE, `Invalid agent response: ${detail}`);

/** Şema doğrulaması; aşırı derin bir yanıtta zod'un yığın taşması da geçersiz yanıt sayılır. */
function validate<T>(schema: z.ZodType<T>, value: unknown): ReturnType<z.ZodType<T>['safeParse']> | null {
  try {
    return schema.safeParse(value);
  } catch {
    return null;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw invalid('yanıt boyut sınırını aşıyor');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Sunucunun hata ayrıntılarından yalnızca `@type` taşıyan nesneler alınır. */
function errorDetails(data: unknown): ErrorDetail[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const details = data.filter(
    (item): item is ErrorDetail =>
      typeof item === 'object' &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as { '@type'?: unknown })['@type'] === 'string',
  );
  return details.length > 0 ? details : undefined;
}

function unwrap<T>(text: string, id: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('JSON değil');
  }
  const envelope = validate(JsonRpcResponseSchema, value);
  if (!envelope?.success) throw invalid('JSON-RPC yanıtı değil');
  const isError = 'error' in envelope.data;
  if (envelope.data.id !== id && !(isError && envelope.data.id === null)) {
    throw invalid('yanıt kimliği istekle eşleşmiyor');
  }
  if ('error' in envelope.data) {
    const { code, message, data } = envelope.data.error;
    throw new A2aError(code, message.slice(0, MAX_ERROR_MESSAGE), errorDetails(data));
  }
  const result = validate(schema, envelope.data.result);
  if (!result) throw invalid('yanıt çözülemedi');
  if (!result.success) throw invalid(result.error.issues[0]?.message ?? 'şema');
  return result.data;
}

export function createA2aClient(options: A2aClientOptions): A2aClient {
  const endpoint = new URL(options.url);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && options.allowInsecureHttp === true)) {
    throw new Error(`createA2aClient: A2A uç noktası https olmalı (${endpoint.protocol})`);
  }
  const doFetch = options.fetch ?? fetch;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  async function headers(accept: string): Promise<Record<string, string>> {
    const extra = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
    return { ...extra, 'content-type': 'application/json', accept, 'a2a-version': A2A_PROTOCOL_VERSION };
  }

  async function post(id: string, method: string, params: unknown, accept: string, signal: AbortSignal) {
    return doFetch(endpoint, {
      method: 'POST',
      headers: await headers(accept),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'error',
      signal,
    });
  }

  async function call<T>(method: string, params: unknown, schema: z.ZodType<T>, request?: RequestOptions): Promise<T> {
    const id = randomUUID();
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = request?.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
    const response = await post(id, method, params, 'application/json', signal);
    return unwrap(await readLimited(response, maxBytes), id, schema);
  }

  async function* stream(method: string, params: unknown, request?: RequestOptions): AsyncGenerator<StreamResponse> {
    const id = randomUUID();
    const controller = new AbortController();
    const external = request?.signal;
    const stop = () => controller.abort(external?.reason);
    if (external?.aborted) stop();
    external?.addEventListener('abort', stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new Error('akış zaman aşımı')), options.timeoutMs);
    };
    try {
      arm();
      const response = await post(id, method, params, 'text/event-stream', controller.signal);
      if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        unwrap(await readLimited(response, maxBytes), id, StreamResponseSchema);
        throw invalid('akış yanıtı bekleniyordu');
      }
      if (!response.body) throw invalid('boş akış');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let carriage = false;
      for (;;) {
        arm();
        const { done, value } = await reader.read();
        clearTimeout(idle);
        if (done) return;
        const text: string = carriage && value.startsWith('\n') ? value.slice(1) : value;
        carriage = text.endsWith('\r');
        buffer += text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (Buffer.byteLength(block) > maxBytes) throw invalid('akış olayı boyut sınırını aşıyor');
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) yield unwrap(data, id, StreamResponseSchema);
          boundary = buffer.indexOf('\n\n');
        }
        if (Buffer.byteLength(buffer) > maxBytes) throw invalid('akış olayı boyut sınırını aşıyor');
      }
    } finally {
      clearTimeout(idle);
      external?.removeEventListener('abort', stop);
      controller.abort();
    }
  }

  return {
    sendMessage: (params, request) => call('SendMessage', params, SendMessageResponseSchema, request),
    sendStreamingMessage: (params, request) => stream('SendStreamingMessage', params, request),
    getTask: (params, request) => call('GetTask', params, TaskSchema, request),
    listTasks: (params, request) => call('ListTasks', params, ListTasksResponseSchema, request),
    cancelTask: (params, request) => call('CancelTask', params, TaskSchema, request),
    subscribeToTask: (params, request) => stream('SubscribeToTask', params, request),
  };
}
