// A2A v1.0 JSON-RPC sunucusu (spec §9; docs/design/a2a.md): node:http işleyicisi, akış yöntemleri SSE
// ile. Görevler kalıcı depoda (TaskStore), canlı olaylar veriyolunda; durum geçişleri state.ts'deki
// kurallara ve zincirdeki job durumuna uymak zorundadır. Görev yalnızca onu açan çağırana görünür. Bir
// görevin yazmaları ve agent işleri süreç içinde sırayla çalışır (tek örnek, docs/design/a2a.md §5).
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  A2A_PROTOCOL_VERSION,
  ArtifactSchema,
  CancelTaskRequestSchema,
  GetTaskRequestSchema,
  INTERRUPTED_TASK_STATES,
  ListTasksRequestSchema,
  SendMessageRequestSchema,
  SubscribeToTaskRequestSchema,
  type Artifact,
  type JsonRpcId,
  type ListTasksResponse,
  type Message,
  type SendMessageRequest,
  type SendMessageResponse,
  type StreamResponse,
  type Task,
  type TaskState,
} from '@squaresdk/solana-types';
import type { Authenticator, Caller } from './auth.js';
import { A2aError, errors } from './errors.js';
import { createTaskEventBus, type TaskEvent, type TaskEventBus } from './events.js';
import { errorResponse, parseJsonRpc, parseParams, successResponse } from './jsonrpc.js';
import { createSquareTaskGate, messageContentHash, type JobFacts, type JobSource } from './square.js';
import { openSse, type SseStream } from './sse.js';
import { cancelable, canTransition, consistentWithJob, isTerminal, reconcile } from './state.js';
import {
  TASK_ID_PATTERN,
  TaskStoreError,
  type ListCursor,
  type TaskPatch,
  type TaskRecord,
  type TaskStore,
} from './store.js';

export interface A2aServerLimits {
  maxBodyBytes: number;
  /** Eşzamanlı uzun istekler (akışlar ve bekleyen SendMessage): toplam ve çağıran başına. */
  maxStreams: number;
  maxStreamsPerCaller: number;
  heartbeatMs: number;
  streamMaxDurationMs: number;
  /** `returnImmediately` verilmeyen SendMessage en fazla bu kadar bekler, sonra güncel görevi döner. */
  blockingTimeoutMs: number;
  /** Yanıttaki en fazla geçmiş mesajı. */
  maxHistory: number;
  /** Görev geçmişindeki en fazla mesaj; doluysa istemcinin devam mesajı reddedilir. */
  maxMessagesPerTask: number;
  /** Bir görevin artefaktlarının JSON olarak en büyük toplam boyutu (bayt). */
  maxArtifactBytes: number;
}

/** Agent kodunun görevi ilerlettiği bağlam. Her geçiş zincirdeki job durumuyla denetlenir. */
export interface TaskContext {
  readonly taskId: string;
  /** Görevi açan çağıranın kimliği (`Caller.id`). */
  readonly caller: string;
  readonly job: JobFacts;
  /** Görevi açan mesaj. */
  readonly message: Message;
  /** Görev iptal edilince, zincir uzlaştırmasıyla terminal olunca ya da sunucu kapanınca kesilir. */
  readonly signal: AbortSignal;
  working(text?: string): Promise<void>;
  requireInput(text: string): Promise<void>;
  addArtifact(artifact: Artifact, options?: { append?: boolean; lastChunk?: boolean }): Promise<void>;
  /** Görev zincir uzlaştırmasıyla zaten bu terminal durumdaysa hata vermez; metin geçmişe eklenir. */
  complete(text?: string): Promise<void>;
  fail(text: string): Promise<void>;
  reject(text: string): Promise<void>;
}

export interface TaskExecutor {
  /**
   * Yeni görev ya da `resume()`; sunucu beklemez, hata fırlatılırsa görev FAILED olur. Yeniden başlatmada
   * aynı görev için yeniden çağrılabilir, bu yüzden tekrar çalıştırılabilir olmalıdır.
   */
  onTask(context: TaskContext): Promise<void>;
  /** Terminal olmayan göreve gelen ek mesaj; bir görevin işleri sırayla çalışır. Tanımlı değilse desteklenmez. */
  onMessage?(context: TaskContext, message: Message): Promise<void>;
}

export interface A2aServerOptions {
  /** Görevleri sunan agent'ın AgentRecord adresi. */
  agentRecord: string;
  store: TaskStore;
  jobSource: JobSource;
  authenticate: Authenticator;
  executor: TaskExecutor;
  limits: A2aServerLimits;
  bus?: TaskEventBus;
  now?: () => Date;
  /** Agent, zincir ve depo hataları; tel üzerinden ayrıntı gönderilmez. */
  onError?: (error: unknown) => void;
}

export interface A2aServer {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Yeniden başlatmadan sonra SUBMITTED ve WORKING görevler için `onTask`'ı yeniden çağırır; sayısını döner. */
  resume(): Promise<number>;
  /** Yeni istekleri reddeder, akışları kapatır, agent sinyallerini keser ve çalışan agent işlerini bekler. */
  close(): Promise<void>;
}

const PUSH_METHODS = new Set([
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]);
const DEFAULT_PAGE_SIZE = 50;
/** Sürüm çakışmasında yeniden deneme; süreç içi yazmalar sıralı olduğundan yalnız başka bir yazıcıya karşı. */
const UPDATE_ATTEMPTS = 3;

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.removeAllListeners('data');
        request.resume();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** `A2A-Version` başlığı ya da sorgu parametresi; boşsa 0.3 sayılır (spec §3.6.2), biçimsizse null. */
function requestedVersion(request: IncomingMessage): string | null {
  const header = request.headers['a2a-version'];
  const query = new URLSearchParams((request.url ?? '').split('?')[1] ?? '').get('A2A-Version');
  const raw = (typeof header === 'string' && header.trim()) || query?.trim() || '';
  if (!raw) return '0.3';
  const match = /^(\d{1,4})\.(\d{1,4})/.exec(raw);
  return match ? `${match[1]}.${match[2]}` : null;
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  if (response.destroyed || response.writableEnded) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  response.end(text);
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.statusAt.toISOString(), i: cursor.id })).toString('base64url');
}

function decodeCursor(token: string): ListCursor {
  try {
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    const statusAt = new Date(String(value.t));
    if (typeof value.i !== 'string' || !TASK_ID_PATTERN.test(value.i) || Number.isNaN(statusAt.getTime())) {
      throw new Error('imleç');
    }
    return { statusAt, id: value.i };
  } catch {
    throw errors.invalidParams([{ field: 'pageToken', description: 'geçersiz sayfa belirteci' }]);
  }
}

function mergeArtifact(current: readonly Artifact[], artifact: Artifact, append: boolean): Artifact[] {
  const index = current.findIndex((a) => a.artifactId === artifact.artifactId);
  if (index === -1) return [...current, artifact];
  const merged = append ? { ...current[index]!, parts: [...current[index]!.parts, ...artifact.parts] } : artifact;
  return current.map((a, i) => (i === index ? merged : a));
}

/** Aynı anahtar için işleri sırayla çalıştırır; boşalan zincir haritadan silinir. */
function serial<T>(chains: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const result = (chains.get(key) ?? Promise.resolve()).then(work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
}

const settled = (state: TaskState) => isTerminal(state) || INTERRUPTED_TASK_STATES.has(state);

/** `waitAfter`: bekleyen SendMessage bu sürümden sonraki ilk kesintili ya da terminal durumu bekler; null ise beklemez. */
interface Admitted {
  task: TaskRecord;
  waitAfter: number | null;
}

interface Observed {
  task: TaskRecord;
  job: JobFacts | null;
}

export function createA2aServer(options: A2aServerOptions): A2aServer {
  const { agentRecord, store, jobSource, executor, limits } = options;
  const bus = options.bus ?? createTaskEventBus();
  const now = options.now ?? (() => new Date());
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      return;
    }
  };
  const gate = createSquareTaskGate({ agentRecord, jobSource });
  const controllers = new Map<string, AbortController>();
  const running = new Set<Promise<void>>();
  const writes = new Map<string, Promise<void>>();
  const queues = new Map<string, Promise<void>>();
  const streams = new Set<SseStream>();
  const streamsByCaller = new Map<string, number>();
  let streamCount = 0;
  let closing = false;

  const locked = <T>(taskId: string, work: () => Promise<T>) => serial(writes, taskId, work);

  function toWire(task: TaskRecord, history?: Message[], artifacts: 'auto' | 'always' | 'never' = 'auto'): Task {
    const includeArtifacts = artifacts === 'always' || (artifacts === 'auto' && task.artifacts.length > 0);
    return {
      id: task.id,
      contextId: task.contextId,
      status: {
        state: task.state,
        ...(task.statusMessage ? { message: task.statusMessage } : {}),
        timestamp: task.statusAt.toISOString(),
      },
      ...(includeArtifacts ? { artifacts: task.artifacts } : {}),
      ...(history && history.length > 0 ? { history } : {}),
      metadata: {
        square: {
          job: task.job,
          specHash: task.specHash,
          jobStatus: task.jobStatus,
          ...(task.jobSlot !== null ? { slot: task.jobSlot } : {}),
        },
      },
    };
  }

  async function wireWithHistory(task: TaskRecord, historyLength: number | undefined): Promise<Task> {
    const limit = Math.min(historyLength ?? limits.maxHistory, limits.maxHistory);
    return toWire(task, limit > 0 ? await store.history(task.id, limit) : undefined);
  }

  function finish(taskId: string) {
    controllers.get(taskId)?.abort();
    controllers.delete(taskId);
  }

  async function scoped(caller: string, id: string): Promise<TaskRecord> {
    const task = await store.get(agentRecord, id);
    if (!task || task.caller !== caller) throw errors.taskNotFound();
    return task;
  }

  /**
   * Görevi zincirdeki job ile uzlaştırır (yalnızca ileri; terminal görev değişmez). Yalnızca görev ya da
   * job durumu değişince yazar; slot yanıtta güncel tutulur. `tolerant` ise zincir hatası raporlanır ve
   * kayıttaki görev döner. Görevin kilidi içinde çağrılır.
   */
  async function reconcileTask(task: TaskRecord, tolerant: boolean): Promise<Observed> {
    let job: JobFacts | null;
    try {
      job = await jobSource.getJob(task.job);
    } catch (error) {
      if (!tolerant) throw error;
      report(error);
      return { task, job: null };
    }
    if (!job) return { task, job: null };
    const state = reconcile(task.state, job.status);
    if (state === task.state && job.status === task.jobStatus) return { task: { ...task, jobSlot: job.slot }, job };
    const patch: TaskPatch = { jobStatus: job.status, jobSlot: job.slot };
    if (state !== task.state) Object.assign(patch, { state, statusAt: now(), statusMessage: null });
    try {
      const updated = await store.update(agentRecord, task.id, task.version, patch);
      if (state !== task.state) {
        bus.publish(task.id, { kind: 'status', task: updated });
        if (isTerminal(state)) finish(task.id);
      }
      return { task: updated, job };
    } catch (error) {
      if (error instanceof TaskStoreError && error.kind === 'version') {
        return { task: (await store.get(agentRecord, task.id)) ?? task, job };
      }
      throw error;
    }
  }

  /** Görevi kilit içinde depodan taze okuyup zincirle uzlaştırır. */
  function observe(taskId: string, tolerant: boolean): Promise<Observed> {
    return locked(taskId, async () => {
      const task = await store.get(agentRecord, taskId);
      if (!task) throw errors.taskNotFound();
      return reconcileTask(task, tolerant);
    });
  }

  function agentMessage(task: TaskRecord, text: string): Message {
    return {
      messageId: randomUUID(),
      contextId: task.contextId,
      taskId: task.id,
      role: 'ROLE_AGENT',
      parts: [{ text }],
    };
  }

  /** Agent kaynaklı durum geçişi: durum makinesi ve zincirdeki job ile tutarlı olmalı. */
  function transition(taskId: string, target: TaskState, text?: string): Promise<void> {
    return locked(taskId, async () => {
      for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
        const current = await store.get(agentRecord, taskId);
        if (!current) throw new Error(`görev yok: ${taskId}`);
        if (current.state === target && isTerminal(target)) {
          if (text) await store.appendMessage(taskId, agentMessage(current, text));
          return;
        }
        if (!canTransition(current.state, target)) {
          throw new Error(`geçersiz görev geçişi: ${current.state} → ${target}`);
        }
        const job = await jobSource.getJob(current.job);
        if (!job) throw new Error(`job zincirde yok: ${current.job}`);
        if (!consistentWithJob(target, job.status)) {
          throw new Error(`${target} job durumu ${job.status} ile tutarsız`);
        }
        const statusMessage = text ? agentMessage(current, text) : null;
        try {
          const updated = await store.update(
            agentRecord,
            taskId,
            current.version,
            { state: target, statusAt: now(), statusMessage, jobStatus: job.status, jobSlot: job.slot },
            statusMessage ?? undefined,
          );
          bus.publish(taskId, { kind: 'status', task: updated });
          if (isTerminal(target)) finish(taskId);
          return;
        } catch (error) {
          if (!(error instanceof TaskStoreError && error.kind === 'version')) throw error;
        }
      }
      throw new Error('görev güncellemesi eşzamanlı yazmalar yüzünden yapılamadı');
    });
  }

  function addArtifact(taskId: string, input: Artifact, append: boolean, lastChunk: boolean): Promise<void> {
    const artifact = ArtifactSchema.parse(input);
    return locked(taskId, async () => {
      for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
        const current = await store.get(agentRecord, taskId);
        if (!current) throw new Error(`görev yok: ${taskId}`);
        if (isTerminal(current.state)) throw new Error(`terminal göreve artefakt eklenemez: ${current.state}`);
        const artifacts = mergeArtifact(current.artifacts, artifact, append);
        if (Buffer.byteLength(JSON.stringify(artifacts)) > limits.maxArtifactBytes) {
          throw new Error(`görevin artefaktları ${limits.maxArtifactBytes} bayt sınırını aşıyor`);
        }
        try {
          const updated = await store.update(agentRecord, taskId, current.version, { artifacts });
          bus.publish(taskId, { kind: 'artifact', task: updated, artifact, append, lastChunk });
          return;
        } catch (error) {
          if (!(error instanceof TaskStoreError && error.kind === 'version')) throw error;
        }
      }
      throw new Error('artefakt eşzamanlı yazmalar yüzünden eklenemedi');
    });
  }

  function contextFor(task: TaskRecord, job: JobFacts, message: Message, signal: AbortSignal): TaskContext {
    return {
      taskId: task.id,
      caller: task.caller,
      job,
      message,
      signal,
      working: (text) => transition(task.id, 'TASK_STATE_WORKING', text),
      requireInput: (text) => transition(task.id, 'TASK_STATE_INPUT_REQUIRED', text),
      addArtifact: (artifact, opts) => addArtifact(task.id, artifact, opts?.append ?? false, opts?.lastChunk ?? false),
      complete: (text) => transition(task.id, 'TASK_STATE_COMPLETED', text),
      fail: (text) => transition(task.id, 'TASK_STATE_FAILED', text),
      reject: (text) => transition(task.id, 'TASK_STATE_REJECTED', text),
    };
  }

  function track(work: Promise<void>) {
    running.add(work);
    void work.then(
      () => running.delete(work),
      () => running.delete(work),
    );
  }

  /** Agent işini görevin kuyruğuna ekler; hata fırlatırsa görev (hâlâ uygunsa) FAILED olur. */
  function run(taskId: string, work: () => Promise<void>, signal: AbortSignal) {
    track(
      serial(queues, taskId, async () => {
        if (signal.aborted) return;
        try {
          await work();
        } catch (error) {
          report(error);
          if (signal.aborted) return;
          await transition(taskId, 'TASK_STATE_FAILED', 'agent görevi tamamlayamadı').catch(report);
        }
      }),
    );
  }

  function controllerFor(taskId: string): AbortController {
    const existing = controllers.get(taskId);
    if (existing) return existing;
    const controller = new AbortController();
    controllers.set(taskId, controller);
    return controller;
  }

  function start(task: TaskRecord, job: JobFacts, message: Message) {
    const { signal } = controllerFor(task.id);
    run(task.id, () => executor.onTask(contextFor(task, job, message, signal)), signal);
  }

  const messageIdConflict = () => new TaskStoreError('message-id', 'aynı mesaj kimliği farklı içerikle kullanıldı');

  async function openTask(caller: Caller, message: Message): Promise<Admitted> {
    const createHash = messageContentHash(message);
    const prior = await store.findCreated(agentRecord, caller.id, message.messageId);
    if (prior) {
      if (prior.createHash !== createHash) throw messageIdConflict();
      return { task: (await observe(prior.id, true)).task, waitAfter: -1 };
    }
    const decision = await gate.admitCreate(message, caller);
    const { task, created } = await store.create({
      agentRecord,
      caller: caller.id,
      job: decision.job.address,
      specHash: decision.specHash,
      createHash,
      message,
      statusAt: now(),
      jobStatus: decision.job.status,
      jobSlot: decision.job.slot,
    });
    if (created) start(task, decision.job, message);
    return { task, waitAfter: -1 };
  }

  async function continueTask(caller: Caller, message: Message): Promise<Admitted> {
    const task = await scoped(caller.id, message.taskId!);
    if (message.contextId !== undefined && message.contextId !== task.contextId) {
      throw errors.rejectedParams(
        'CONTEXT_ID_MISMATCH',
        'message.contextId',
        'mesajın bağlamı görevinkiyle eşleşmiyor',
      );
    }
    const onMessage = executor.onMessage?.bind(executor);
    if (!onMessage) throw errors.unsupportedOperation('CONTINUATION_NOT_SUPPORTED');
    return locked(task.id, async () => {
      const fresh = await store.get(agentRecord, task.id);
      if (!fresh) throw errors.taskNotFound();
      const known = await store.message(fresh.id, message.messageId);
      if (known) {
        if (messageContentHash(known) !== messageContentHash(message)) throw messageIdConflict();
        return { task: fresh, waitAfter: null };
      }
      const { task: current, job } = await reconcileTask(fresh, false);
      if (isTerminal(current.state)) throw errors.unsupportedOperation('TASK_TERMINAL', { state: current.state });
      if (!job) throw errors.rejectedParams('JOB_NOT_FOUND', 'message.taskId', "görevin job'u zincirde yok");
      if (!(await store.appendMessage(current.id, message, { maxMessages: limits.maxMessagesPerTask }))) {
        return { task: current, waitAfter: null };
      }
      const opening = (await store.message(current.id, current.createMessageId)) ?? message;
      const { signal } = controllerFor(current.id);
      run(current.id, () => onMessage(contextFor(current, job, opening, signal), message), signal);
      return { task: current, waitAfter: current.version };
    });
  }

  async function admit(caller: Caller, request: SendMessageRequest): Promise<Admitted> {
    if (request.configuration?.taskPushNotificationConfig !== undefined) throw errors.pushNotificationNotSupported();
    if (request.message.role !== 'ROLE_USER') {
      throw errors.invalidParams([{ field: 'message.role', description: 'istemci mesajı ROLE_USER olmalı' }]);
    }
    return request.message.taskId ? continueTask(caller, request.message) : openTask(caller, request.message);
  }

  /** Görev `waitAfter`'dan sonraki ilk kesintili ya da terminal duruma gelene, süre dolana ya da istemci ayrılana kadar bekler. */
  async function waitSettled(admitted: Admitted, abort: AbortSignal): Promise<TaskRecord> {
    const { task, waitAfter } = admitted;
    if (waitAfter === null) return task;
    const done = (candidate: TaskRecord) => candidate.version > waitAfter && settled(candidate.state);
    if (done(task)) return task;
    await new Promise<void>((resolve) => {
      let stopped = false;
      const timer = setTimeout(stop, limits.blockingTimeoutMs);
      const unsubscribe = bus.subscribe(task.id, (event) => {
        if (event.kind === 'status' && done(event.task)) stop();
      });
      abort.addEventListener('abort', stop, { once: true });
      function stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        unsubscribe();
        abort.removeEventListener('abort', stop);
        resolve();
      }
      if (abort.aborted) stop();
      void store.get(agentRecord, task.id).then((latest) => {
        if (latest && done(latest)) stop();
      }, stop);
    });
    return (await store.get(agentRecord, task.id)) ?? task;
  }

  /** Uzun istek yerini görev açılmadan ayırır: sınır aşılınca görev oluşmaz. Dönen fonksiyon yeri bırakır. */
  function reserveStream(caller: string): () => void {
    const callerStreams = streamsByCaller.get(caller) ?? 0;
    if (streamCount >= limits.maxStreams || callerStreams >= limits.maxStreamsPerCaller) throw errors.tooManyStreams();
    streamCount += 1;
    streamsByCaller.set(caller, callerStreams + 1);
    return () => {
      streamCount -= 1;
      const remaining = (streamsByCaller.get(caller) ?? 1) - 1;
      if (remaining > 0) streamsByCaller.set(caller, remaining);
      else streamsByCaller.delete(caller);
    };
  }

  async function sendMessage(
    response: ServerResponse,
    caller: Caller,
    request: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    const blocking = request.configuration?.returnImmediately !== true;
    const release = blocking ? reserveStream(caller.id) : () => undefined;
    const disconnected = new AbortController();
    const onClose = () => disconnected.abort();
    response.once('close', onClose);
    try {
      const admitted = await admit(caller, request);
      const result = blocking ? await waitSettled(admitted, disconnected.signal) : admitted.task;
      return { task: await wireWithHistory(result, request.configuration?.historyLength) };
    } finally {
      response.off('close', onClose);
      release();
    }
  }

  function streamEvent(event: TaskEvent): StreamResponse {
    const { task } = event;
    if (event.kind === 'artifact') {
      return {
        artifactUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          artifact: event.artifact,
          append: event.append,
          lastChunk: event.lastChunk,
        },
      };
    }
    const wire = toWire(task);
    return {
      statusUpdate: { taskId: task.id, contextId: task.contextId, status: wire.status, metadata: wire.metadata! },
    };
  }

  /** Görev akışı: önce görev, sonra olaylar; görev terminal olunca kapanır (spec §3.1.2). */
  async function stream(response: ServerResponse, id: JsonRpcId, taskId: string, historyLength?: number) {
    const pending: TaskEvent[] = [];
    let lastVersion = -1;
    let ready = false;
    let sse: SseStream | null = null;
    const deliver = (event: TaskEvent) => {
      if (event.task.version <= lastVersion || !sse) return;
      lastVersion = event.task.version;
      sse.send(successResponse(id, streamEvent(event)));
      if (event.kind === 'status' && isTerminal(event.task.state)) sse.close();
    };
    const unsubscribe = bus.subscribe(taskId, (event) => (ready ? deliver(event) : pending.push(event)));
    try {
      const snapshot = await store.get(agentRecord, taskId);
      if (!snapshot) throw errors.taskNotFound();
      sse = openSse(response, {
        heartbeatMs: limits.heartbeatMs,
        maxDurationMs: limits.streamMaxDurationMs,
        maxBufferedBytes: limits.maxBodyBytes * 4,
      });
      streams.add(sse);
      lastVersion = snapshot.version;
      sse.send(successResponse(id, { task: await wireWithHistory(snapshot, historyLength) }));
      ready = true;
      for (const event of pending.splice(0)) deliver(event);
      if (isTerminal(snapshot.state)) sse.close();
      await sse.closed;
    } finally {
      unsubscribe();
      if (sse) {
        sse.close();
        streams.delete(sse);
      }
    }
  }

  async function listTasks(caller: Caller, params: unknown): Promise<ListTasksResponse> {
    const request = parseParams(ListTasksRequestSchema, params);
    const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
    const result = await store.list(agentRecord, caller.id, {
      pageSize,
      ...(request.contextId ? { contextId: request.contextId } : {}),
      ...(request.status ? { state: request.status } : {}),
      ...(request.statusTimestampAfter ? { statusAfter: new Date(request.statusTimestampAfter) } : {}),
      ...(request.pageToken ? { after: decodeCursor(request.pageToken) } : {}),
      withArtifacts: request.includeArtifacts === true,
    });
    const historyLength = Math.min(request.historyLength ?? 0, limits.maxHistory);
    const tasks = await Promise.all(
      result.tasks.map(async (task) =>
        toWire(
          task,
          historyLength > 0 ? await store.history(task.id, historyLength) : undefined,
          request.includeArtifacts ? 'always' : 'never',
        ),
      ),
    );
    return {
      tasks,
      nextPageToken: result.next ? encodeCursor(result.next) : '',
      pageSize,
      totalSize: result.totalSize,
    };
  }

  async function cancelTask(caller: Caller, params: unknown): Promise<Task> {
    const request = parseParams(CancelTaskRequestSchema, params);
    const task = await scoped(caller.id, request.id);
    const canceled = await locked(task.id, async () => {
      for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
        const fresh = await store.get(agentRecord, task.id);
        if (!fresh) throw errors.taskNotFound();
        const { task: current, job } = await reconcileTask(fresh, false);
        if (current.state === 'TASK_STATE_CANCELED') return current;
        if (!job || !cancelable(current.state, job.status)) throw errors.taskNotCancelable(current.state);
        try {
          const updated = await store.update(agentRecord, current.id, current.version, {
            state: 'TASK_STATE_CANCELED',
            statusAt: now(),
            statusMessage: null,
            jobStatus: job.status,
            jobSlot: job.slot,
          });
          bus.publish(current.id, { kind: 'status', task: updated });
          finish(current.id);
          return updated;
        } catch (error) {
          if (!(error instanceof TaskStoreError && error.kind === 'version')) throw error;
        }
      }
      throw errors.internal();
    });
    return wireWithHistory(canceled, undefined);
  }

  function toA2aError(error: unknown): A2aError {
    if (error instanceof A2aError) return error;
    if (error instanceof TaskStoreError) {
      if (error.kind === 'message-id') {
        return errors.rejectedParams(
          'MESSAGE_ID_CONFLICT',
          'message.messageId',
          'aynı mesaj kimliği farklı içerikle kullanıldı',
        );
      }
      if (error.kind === 'active-task') {
        return errors.rejectedParams(
          'JOB_HAS_ACTIVE_TASK',
          'message.metadata.square.job',
          'job için sürmekte olan bir görev var',
        );
      }
      if (error.kind === 'message-limit') {
        return errors.unsupportedOperation('TASK_MESSAGE_LIMIT', { limit: String(limits.maxMessagesPerTask) });
      }
      if (error.kind === 'not-found') return errors.taskNotFound();
    }
    report(error);
    return errors.internal();
  }

  async function dispatch(response: ServerResponse, id: JsonRpcId, caller: Caller, method: string, params: unknown) {
    switch (method) {
      case 'SendMessage': {
        const request = parseParams(SendMessageRequestSchema, params);
        return sendJson(response, 200, successResponse(id, await sendMessage(response, caller, request)));
      }
      case 'SendStreamingMessage': {
        const request = parseParams(SendMessageRequestSchema, params);
        const release = reserveStream(caller.id);
        try {
          const { task } = await admit(caller, request);
          return await stream(response, id, task.id, request.configuration?.historyLength);
        } finally {
          release();
        }
      }
      case 'GetTask': {
        const request = parseParams(GetTaskRequestSchema, params);
        const task = await scoped(caller.id, request.id);
        const { task: fresh } = await observe(task.id, true);
        return sendJson(response, 200, successResponse(id, await wireWithHistory(fresh, request.historyLength)));
      }
      case 'ListTasks':
        return sendJson(response, 200, successResponse(id, await listTasks(caller, params)));
      case 'CancelTask':
        return sendJson(response, 200, successResponse(id, await cancelTask(caller, params)));
      case 'SubscribeToTask': {
        const request = parseParams(SubscribeToTaskRequestSchema, params);
        const task = await scoped(caller.id, request.id);
        const { task: fresh } = await observe(task.id, true);
        if (isTerminal(fresh.state)) throw errors.unsupportedOperation('TASK_TERMINAL', { state: fresh.state });
        const release = reserveStream(caller.id);
        try {
          return await stream(response, id, fresh.id);
        } finally {
          release();
        }
      }
      case 'GetExtendedAgentCard':
        throw errors.extendedAgentCardNotConfigured();
      default:
        if (PUSH_METHODS.has(method)) throw errors.pushNotificationNotSupported();
        throw errors.methodNotFound(method);
    }
  }

  /** Gövdesi okunmamış ya da okunması kesilmiş isteklerde bağlantı kapatılır. */
  const CLOSE_CONNECTION = new Set([401, 413, 503]);

  function fail(response: ServerResponse, id: JsonRpcId, error: A2aError) {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendJson(
      response,
      error.httpStatus,
      errorResponse(id, error),
      CLOSE_CONNECTION.has(error.httpStatus) ? { connection: 'close' } : {},
    );
  }

  return {
    async handle(request, response) {
      if (closing) {
        fail(response, null, errors.unavailable());
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
        fail(response, null, errors.invalidRequest('content-type application/json olmalı', 415));
        return;
      }
      let caller: Caller | null;
      try {
        caller = await options.authenticate(request);
      } catch (error) {
        fail(response, null, toA2aError(error));
        return;
      }
      if (!caller) {
        fail(response, null, errors.unauthenticated());
        return;
      }
      let body: string;
      try {
        body = await readBody(request, limits.maxBodyBytes);
      } catch (error) {
        if (error instanceof BodyTooLarge) fail(response, null, errors.invalidRequest('istek gövdesi çok büyük', 413));
        else fail(response, null, errors.invalidRequest('istek gövdesi okunamadı'));
        return;
      }
      const parsed = parseJsonRpc(body);
      if (!parsed.ok) {
        fail(response, parsed.id, parsed.error);
        return;
      }
      const { id, method, params } = parsed.request;
      try {
        const version = requestedVersion(request);
        if (version !== A2A_PROTOCOL_VERSION) throw errors.versionNotSupported(version);
        await dispatch(response, id, caller, method, params);
      } catch (error) {
        fail(response, id, toA2aError(error));
      }
    },

    async resume() {
      let resumed = 0;
      for (const task of await store.active(agentRecord)) {
        try {
          const { task: current, job } = await observe(task.id, true);
          if (!job || (current.state !== 'TASK_STATE_SUBMITTED' && current.state !== 'TASK_STATE_WORKING')) continue;
          const opening = await store.message(current.id, current.createMessageId);
          if (!opening) continue;
          start(current, job, opening);
          resumed += 1;
        } catch (error) {
          report(error);
        }
      }
      return resumed;
    },

    async close() {
      closing = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      for (const sse of [...streams]) sse.close();
      await Promise.allSettled([...running]);
    },
  };
}
