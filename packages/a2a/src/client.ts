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
  /** İstek süresi; akışlarda olaylar arası en uzun bekleme. */
  timeoutMs: number;
  /** Her isteğe eklenen başlıklar (ör. kimlik doğrulama). */
  headers?: Readonly<Record<string, string>> | (() => Promise<Readonly<Record<string, string>>>);
  /** Yalnızca yerel geliştirme ve testler: http uç noktasına izin verir. */
  allowInsecureHttp?: boolean;
  /** Bir yanıtın ya da tek bir akış olayının en büyük boyutu (bayt). */
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

export interface A2aClient {
  sendMessage(params: SendMessageRequest): Promise<SendMessageResponse>;
  sendStreamingMessage(params: SendMessageRequest): AsyncIterable<StreamResponse>;
  getTask(params: GetTaskRequest): Promise<Task>;
  listTasks(params: ListTasksRequest): Promise<ListTasksResponse>;
  cancelTask(params: CancelTaskRequest): Promise<Task>;
  subscribeToTask(params: SubscribeToTaskRequest): AsyncIterable<StreamResponse>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const INVALID_RESPONSE = -32006;

const invalid = (detail: string) => new A2aError(INVALID_RESPONSE, `Invalid agent response: ${detail}`);

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

function unwrap<T>(text: string, id: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('JSON değil');
  }
  const envelope = JsonRpcResponseSchema.safeParse(value);
  if (!envelope.success) throw invalid('JSON-RPC yanıtı değil');
  if (envelope.data.id !== id && envelope.data.id !== null) throw invalid('yanıt kimliği istekle eşleşmiyor');
  if ('error' in envelope.data) {
    const { code, message, data } = envelope.data.error;
    throw new A2aError(code, message, Array.isArray(data) ? (data as ErrorDetail[]) : undefined);
  }
  const result = schema.safeParse(envelope.data.result);
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

  async function call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const id = randomUUID();
    const signal = AbortSignal.timeout(options.timeoutMs);
    const response = await post(id, method, params, 'application/json', signal);
    return unwrap(await readLimited(response, maxBytes), id, schema);
  }

  async function* stream(method: string, params: unknown): AsyncGenerator<StreamResponse> {
    const id = randomUUID();
    const controller = new AbortController();
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        arm();
        buffer = (buffer + value).replaceAll('\r\n', '\n');
        if (buffer.length > maxBytes) throw invalid('akış olayı boyut sınırını aşıyor');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) yield unwrap(data, id, StreamResponseSchema);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      clearTimeout(idle);
      controller.abort();
    }
  }

  return {
    sendMessage: (params) => call('SendMessage', params, SendMessageResponseSchema),
    sendStreamingMessage: (params) => stream('SendStreamingMessage', params),
    getTask: (params) => call('GetTask', params, TaskSchema),
    listTasks: (params) => call('ListTasks', params, ListTasksResponseSchema),
    cancelTask: (params) => call('CancelTask', params, TaskSchema),
    subscribeToTask: (params) => stream('SubscribeToTask', params),
  };
}
