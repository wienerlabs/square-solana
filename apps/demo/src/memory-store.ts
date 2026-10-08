import { randomUUID } from 'node:crypto';
import {
  TaskStoreError,
  type ListFilter,
  type ListResult,
  type NewTask,
  type StoredMessage,
  type TaskPatch,
  type TaskRecord,
  type TaskStore,
} from '@squaresdk/solana-a2a';
import { TERMINAL_TASK_STATES, type Message } from '@squaresdk/solana-types';

interface StoredTask {
  record: TaskRecord;
  messages: StoredMessage[];
}

const copy = <T>(value: T): T => structuredClone(value);
const notFound = () => new TaskStoreError('not-found', 'görev yok');
const withoutArtifacts = (record: TaskRecord): TaskRecord => ({ ...copy(record), artifacts: [] });

const newestFirst = (a: TaskRecord, b: TaskRecord) =>
  b.statusAt.getTime() - a.statusAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const afterCursor = (record: TaskRecord, cursor: NonNullable<ListFilter['after']>) =>
  record.statusAt.getTime() < cursor.statusAt.getTime() ||
  (record.statusAt.getTime() === cursor.statusAt.getTime() && record.id < cursor.id);

export function createMemoryTaskStore(now: () => Date = () => new Date()): TaskStore {
  const tasks = new Map<string, StoredTask>();

  const created = (agentRecord: string, caller: string, messageId: string) =>
    [...tasks.values()].find(
      ({ record }) =>
        record.agentRecord === agentRecord && record.caller === caller && record.createMessageId === messageId,
    ) ?? null;

  const owned = (agentRecord: string, id: string) => {
    const task = tasks.get(id);
    return task && task.record.agentRecord === agentRecord ? task : null;
  };

  const stored = (taskId: string) => {
    const task = tasks.get(taskId);
    if (!task) throw notFound();
    return task;
  };

  return {
    async create(task: NewTask) {
      const existing = created(task.agentRecord, task.caller, task.message.messageId);
      if (existing) {
        if (existing.record.createHash !== task.createHash || existing.record.job !== task.job) {
          throw new TaskStoreError('message-id', 'aynı mesaj kimliği farklı içerikle kullanıldı');
        }
        return { task: copy(existing.record), created: false };
      }
      const active = [...tasks.values()].some(
        ({ record }) =>
          record.agentRecord === task.agentRecord && record.job === task.job && !TERMINAL_TASK_STATES.has(record.state),
      );
      if (active) throw new TaskStoreError('active-task', 'job için terminal olmayan bir görev var');
      const record: TaskRecord = {
        id: randomUUID(),
        agentRecord: task.agentRecord,
        caller: task.caller,
        contextId: task.job,
        job: task.job,
        specHash: task.specHash,
        state: 'TASK_STATE_SUBMITTED',
        statusMessage: null,
        statusAt: new Date(task.statusAt),
        artifacts: [],
        createMessageId: task.message.messageId,
        createHash: task.createHash,
        jobStatus: task.jobStatus,
        jobSlot: task.jobSlot,
        version: 0,
        createdAt: now(),
      };
      tasks.set(record.id, { record, messages: [{ message: copy(task.message), pending: false }] });
      return { task: copy(record), created: true };
    },

    async findCreated(agentRecord, caller, messageId) {
      const task = created(agentRecord, caller, messageId);
      return task ? copy(task.record) : null;
    },

    async get(agentRecord, id) {
      const task = owned(agentRecord, id);
      return task ? copy(task.record) : null;
    },

    async list(agentRecord, caller, filter: ListFilter): Promise<ListResult> {
      const matching = [...tasks.values()]
        .map(({ record }) => record)
        .filter(
          (record) =>
            record.agentRecord === agentRecord &&
            record.caller === caller &&
            (!filter.contextId || record.job === filter.contextId) &&
            (!filter.state || record.state === filter.state) &&
            (!filter.statusAfter || record.statusAt.getTime() >= filter.statusAfter.getTime()),
        )
        .sort(newestFirst);
      const after = filter.after;
      const page = after ? matching.filter((record) => afterCursor(record, after)) : matching;
      const selected = page
        .slice(0, filter.pageSize)
        .map((record) => (filter.withArtifacts === true ? copy(record) : withoutArtifacts(record)));
      const last = selected.at(-1);
      return {
        tasks: selected,
        totalSize: matching.length,
        next: page.length > filter.pageSize && last ? { statusAt: last.statusAt, id: last.id } : null,
      };
    },

    async active(agentRecord) {
      return [...tasks.values()]
        .map(({ record }) => record)
        .filter((record) => record.agentRecord === agentRecord && !TERMINAL_TASK_STATES.has(record.state))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(withoutArtifacts);
    },

    async update(agentRecord, id, expectedVersion, patch: TaskPatch, message?: Message) {
      const task = owned(agentRecord, id);
      if (!task) throw notFound();
      if (task.record.version !== expectedVersion) {
        throw new TaskStoreError('version', 'görev başka bir güncellemeyle değişti');
      }
      if (message && task.messages.some((item) => item.message.messageId === message.messageId)) {
        throw new TaskStoreError('message-id', 'mesaj kimliği görevin geçmişinde var');
      }
      const record: TaskRecord = {
        ...task.record,
        ...(patch.state ? { state: patch.state } : {}),
        ...(patch.statusAt ? { statusAt: new Date(patch.statusAt) } : {}),
        ...(patch.statusMessage !== undefined ? { statusMessage: copy(patch.statusMessage) } : {}),
        ...(patch.artifacts ? { artifacts: copy(patch.artifacts) } : {}),
        ...(patch.jobStatus ? { jobStatus: patch.jobStatus } : {}),
        ...(patch.jobSlot !== undefined ? { jobSlot: patch.jobSlot } : {}),
        version: task.record.version + 1,
      };
      task.record = record;
      if (message) task.messages.push({ message: copy(message), pending: false });
      return copy(record);
    },

    async appendMessage(taskId, message, options) {
      const task = stored(taskId);
      if (task.messages.some((item) => item.message.messageId === message.messageId)) return false;
      const max = options?.maxMessages;
      if (max !== undefined && task.messages.length >= max) {
        throw new TaskStoreError('message-limit', `görevin geçmişi ${max} mesajla dolu`);
      }
      task.messages.push({ message: copy(message), pending: options?.pending === true });
      return true;
    },

    async message(taskId, messageId) {
      const found = tasks.get(taskId)?.messages.find((item) => item.message.messageId === messageId);
      return found ? copy(found) : null;
    },

    async pendingMessages(taskId) {
      return (tasks.get(taskId)?.messages ?? []).filter((item) => item.pending).map((item) => copy(item.message));
    },

    async markProcessed(taskId, messageId) {
      for (const item of tasks.get(taskId)?.messages ?? []) {
        if (item.message.messageId === messageId) item.pending = false;
      }
    },

    async history(taskId, limit) {
      if (limit === 0) return [];
      const messages = (tasks.get(taskId)?.messages ?? []).map((item) => copy(item.message));
      return limit === undefined ? messages : messages.slice(-limit);
    },
  };
}
