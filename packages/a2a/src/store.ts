// Görev deposu arayüzü (docs/design/a2a.md §5). Ürün uygulaması Postgres üzerindedir
// (`@squaresdk/solana-a2a/prisma`, a2a_tasks ve a2a_messages tabloları).
import type { Artifact, JobStatus, Message, TaskState } from '@squaresdk/solana-types';

export interface TaskRecord {
  id: string;
  /** Görevi sunan agent'ın AgentRecord adresi. */
  agentRecord: string;
  /** Kimliği doğrulanmış çağıran; görev yalnızca ona görünür. */
  caller: string;
  contextId: string;
  job: string;
  specHash: string;
  state: TaskState;
  statusMessage: Message | null;
  statusAt: Date;
  artifacts: Artifact[];
  createMessageId: string;
  createHash: string;
  jobStatus: JobStatus | null;
  jobSlot: number | null;
  /** İyimser eşzamanlılık sayacı. */
  version: number;
  createdAt: Date;
}

export interface NewTask {
  agentRecord: string;
  caller: string;
  contextId: string;
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
}

export interface ListResult {
  tasks: TaskRecord[];
  totalSize: number;
  next: ListCursor | null;
}

/** `message-id`: aynı mesaj kimliği farklı içerikle; `active-task`: job'un terminal olmayan görevi var. */
export type TaskStoreErrorKind = 'message-id' | 'active-task' | 'version' | 'not-found';

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
  get(agentRecord: string, id: string): Promise<TaskRecord | null>;
  /** Durum zamanına göre azalan; imleç (`after`) ile sayfalanır. */
  list(agentRecord: string, caller: string, filter: ListFilter): Promise<ListResult>;
  /** `expectedVersion` güncel değilse `version` hatası verir. */
  update(agentRecord: string, id: string, expectedVersion: number, patch: TaskPatch): Promise<TaskRecord>;
  /** Mesajı geçmişe ekler; aynı mesaj kimliği zaten varsa false. */
  appendMessage(taskId: string, message: Message): Promise<boolean>;
  /** Geçmiş, eklenme sırasıyla; `limit` en son mesajları sınırlar. */
  history(taskId: string, limit?: number): Promise<Message[]>;
}
