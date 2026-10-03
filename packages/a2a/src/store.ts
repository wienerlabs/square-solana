// Görev deposu arayüzü (docs/design/a2a.md §7). Ürün uygulaması Postgres üzerindedir
// (`@squaresdk/solana-a2a/prisma`, a2a_tasks ve a2a_messages tabloları).
import type { Artifact, JobStatus, Message, TaskState } from '@squaresdk/solana-types';

/** Görev kimlikleri UUID'dir; başka biçimdeki kimlik için görev yoktur. */
export const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TaskRecord {
  id: string;
  /** Görevi sunan agent'ın AgentRecord adresi. */
  agentRecord: string;
  /** Kimliği doğrulanmış çağıran; görev yalnızca ona görünür. */
  caller: string;
  /** Görevin bağlamı job adresidir. */
  contextId: string;
  job: string;
  specHash: string;
  state: TaskState;
  statusMessage: Message | null;
  statusAt: Date;
  /** `list` artefaktlar istenmeden çağrıldıysa boş. */
  artifacts: Artifact[];
  createMessageId: string;
  createHash: string;
  /** Sunucunun zincirde son gördüğü job durumu ve slot (durum değişince yazılır). */
  jobStatus: JobStatus;
  jobSlot: number | null;
  /** İyimser eşzamanlılık sayacı. */
  version: number;
  createdAt: Date;
}

export interface NewTask {
  agentRecord: string;
  caller: string;
  job: string;
  specHash: string;
  /** Açan mesajın içeriğinin SHA-256'sı (hex); aynı mesaj kimliğiyle farklı içerik reddedilir. */
  createHash: string;
  /** Görevi açan mesaj; geçmişe ilk mesaj olarak yazılır. */
  message: Message;
  statusAt: Date;
  jobStatus: JobStatus;
  jobSlot: number | null;
}

export interface TaskPatch {
  state?: TaskState;
  statusMessage?: Message | null;
  statusAt?: Date;
  artifacts?: Artifact[];
  jobStatus?: JobStatus;
  jobSlot?: number | null;
}

export interface ListCursor {
  statusAt: Date;
  id: string;
}

export interface ListFilter {
  pageSize: number;
  contextId?: string;
  state?: TaskState;
  /** Durum zamanı bu andan önce olmayan görevler. */
  statusAfter?: Date;
  after?: ListCursor;
  /** Artefaktlar yalnızca istenirse okunur. */
  withArtifacts?: boolean;
}

export interface ListResult {
  tasks: TaskRecord[];
  totalSize: number;
  next: ListCursor | null;
}

/**
 * `message-id`: aynı mesaj kimliği farklı içerikle; `active-task`: job'un terminal olmayan görevi var;
 * `message-limit`: görevin geçmişi dolu.
 */
export type TaskStoreErrorKind = 'message-id' | 'active-task' | 'version' | 'not-found' | 'message-limit';

export class TaskStoreError extends Error {
  constructor(
    readonly kind: TaskStoreErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TaskStoreError';
  }
}

export interface TaskStore {
  /** Görevi açar; aynı (agent, çağıran, mesaj kimliği) ve aynı içerik varsa onu döner. */
  create(task: NewTask): Promise<{ task: TaskRecord; created: boolean }>;
  /** Çağıranın bu mesaj kimliğiyle açtığı görev. */
  findCreated(agentRecord: string, caller: string, messageId: string): Promise<TaskRecord | null>;
  get(agentRecord: string, id: string): Promise<TaskRecord | null>;
  /** Durum zamanına göre azalan; imleç (`after`) ile sayfalanır. */
  list(agentRecord: string, caller: string, filter: ListFilter): Promise<ListResult>;
  /** Agent'ın SUBMITTED ve WORKING görevleri; yeniden başlatmada agent'a yeniden verilir. */
  active(agentRecord: string): Promise<TaskRecord[]>;
  /**
   * `expectedVersion` güncel değilse `version` hatası verir. `message` verilirse aynı işlemde geçmişe
   * eklenir; eklenemezse güncelleme de yazılmaz.
   */
  update(
    agentRecord: string,
    id: string,
    expectedVersion: number,
    patch: TaskPatch,
    message?: Message,
  ): Promise<TaskRecord>;
  /**
   * Mesajı geçmişe ekler; aynı mesaj kimliği zaten varsa false. Geçmişte `maxMessages` mesaj varsa
   * `message-limit` hatası verir.
   */
  appendMessage(taskId: string, message: Message, options?: { maxMessages?: number }): Promise<boolean>;
  /** Geçmişteki tek mesaj. */
  message(taskId: string, messageId: string): Promise<Message | null>;
  /** Geçmiş, eklenme sırasıyla; `limit` en son mesajları sınırlar. */
  history(taskId: string, limit?: number): Promise<Message[]>;
}
