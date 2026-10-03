// TaskStore'un Postgres uygulaması: a2a_tasks ve a2a_messages (db/prisma/schema.prisma, BE-17). db
// paketine yalnızca tip olarak bağlıdır; istemci (`createDatabaseClient`) çağırandan gelir.
import type { A2aTaskModel, Prisma, PrismaClient } from '@squaresdk/solana-db';
import { TERMINAL_TASK_STATES, type Artifact, type Message, type TaskState } from '@squaresdk/solana-types';
import {
  TASK_ID_PATTERN,
  TaskStoreError,
  type ListFilter,
  type ListResult,
  type NewTask,
  type TaskPatch,
  type TaskRecord,
  type TaskStore,
} from './store.js';

const TERMINAL = [...TERMINAL_TASK_STATES];
const RESUMABLE: TaskState[] = ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'];

type TaskRow = Omit<A2aTaskModel, 'artifacts'> & { artifacts?: A2aTaskModel['artifacts'] };

const prismaCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;

const notFound = () => new TaskStoreError('not-found', 'görev yok');

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    agentRecord: row.agentRecord,
    caller: row.caller,
    contextId: row.job,
    job: row.job,
    specHash: row.specHash,
    state: row.state,
    statusMessage: isMessage(row.statusMessage) ? row.statusMessage : null,
    statusAt: row.statusAt,
    artifacts: (row.artifacts ?? []) as Artifact[],
    createMessageId: row.createMessageId,
    createHash: row.createHash,
    jobStatus: row.jobStatus,
    jobSlot: row.jobSlot === null ? null : Number(row.jobSlot),
    version: row.version,
    createdAt: row.createdAt,
  };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Durum mesajı yokken sütunda `{}` durur. */
const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && 'messageId' in value;

const messageFields = (message: Message) => ({
  messageId: message.messageId,
  role: message.role,
  content: json(message),
});

const messageRow = (taskId: string, message: Message) => ({ taskId, ...messageFields(message) });

type TaskReader = Pick<PrismaClient, 'a2aTask'>;

export function createPrismaTaskStore(client: PrismaClient): TaskStore {
  async function existing(db: TaskReader, task: NewTask) {
    const row = await db.a2aTask.findUnique({
      where: {
        agentRecord_caller_createMessageId: {
          agentRecord: task.agentRecord,
          caller: task.caller,
          createMessageId: task.message.messageId,
        },
      },
    });
    if (!row) return null;
    if (row.createHash !== task.createHash || row.job !== task.job) {
      throw new TaskStoreError('message-id', 'aynı mesaj kimliği farklı içerikle kullanıldı');
    }
    return { task: toRecord(row), created: false };
  }

  /**
   * Tek etkin görev kuralı: (agent, job) danışma kilidi altında okunur ve yazılır. Kilit sonrası okuma
   * READ COMMITTED'a dayanır; kısmi tekil indeks `a2a_tasks_active_job_key` kilidi almayan yazıcıya karşı korur.
   */
  async function create(task: NewTask) {
    return client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`a2a:${task.agentRecord}:${task.job}`}, 0))`;
        const found = await existing(tx, task);
        if (found) return found;
        const active = await tx.a2aTask.findFirst({
          where: { agentRecord: task.agentRecord, job: task.job, state: { notIn: TERMINAL } },
          select: { id: true },
        });
        if (active) throw new TaskStoreError('active-task', 'job için terminal olmayan bir görev var');
        const row = await tx.a2aTask.create({
          data: {
            agentRecord: task.agentRecord,
            caller: task.caller,
            job: task.job,
            specHash: task.specHash,
            state: 'TASK_STATE_SUBMITTED',
            statusAt: task.statusAt,
            artifacts: json([]),
            createMessageId: task.message.messageId,
            createHash: task.createHash,
            jobStatus: task.jobStatus,
            jobSlot: task.jobSlot === null ? null : BigInt(task.jobSlot),
            messages: { create: messageFields(task.message) },
          },
        });
        return { task: toRecord(row), created: true };
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  async function updateRow(db: TaskReader, agentRecord: string, id: string, expectedVersion: number, patch: TaskPatch) {
    return db.a2aTask.update({
      where: { id, agentRecord, version: expectedVersion },
      data: {
        ...(patch.state ? { state: patch.state } : {}),
        ...(patch.statusAt ? { statusAt: patch.statusAt } : {}),
        ...(patch.statusMessage !== undefined ? { statusMessage: json(patch.statusMessage ?? {}) } : {}),
        ...(patch.artifacts ? { artifacts: json(patch.artifacts) } : {}),
        ...(patch.jobStatus ? { jobStatus: patch.jobStatus } : {}),
        ...(patch.jobSlot !== undefined ? { jobSlot: patch.jobSlot === null ? null : BigInt(patch.jobSlot) } : {}),
        version: { increment: 1 },
      },
    });
  }

  return {
    async create(task) {
      try {
        return await create(task);
      } catch (error) {
        if (prismaCode(error) !== 'P2002') throw error;
        const found = await existing(client, task);
        if (found) return found;
        throw new TaskStoreError('active-task', 'job için terminal olmayan bir görev var');
      }
    },

    async findCreated(agentRecord, caller, messageId) {
      const row = await client.a2aTask.findUnique({
        where: { agentRecord_caller_createMessageId: { agentRecord, caller, createMessageId: messageId } },
      });
      return row ? toRecord(row) : null;
    },

    async get(agentRecord, id) {
      if (!TASK_ID_PATTERN.test(id)) return null;
      const row = await client.a2aTask.findFirst({ where: { id, agentRecord } });
      return row ? toRecord(row) : null;
    },

    async list(agentRecord, caller, filter: ListFilter): Promise<ListResult> {
      const where: Prisma.A2aTaskWhereInput = {
        agentRecord,
        caller,
        ...(filter.contextId ? { job: filter.contextId } : {}),
        ...(filter.state ? { state: filter.state } : {}),
        ...(filter.statusAfter ? { statusAt: { gte: filter.statusAfter } } : {}),
      };
      const page = filter.after
        ? {
            AND: [
              where,
              { statusAt: { lte: filter.after.statusAt } },
              {
                OR: [
                  { statusAt: { lt: filter.after.statusAt } },
                  { statusAt: filter.after.statusAt, id: { lt: filter.after.id } },
                ],
              },
            ],
          }
        : where;
      const [rows, totalSize] = await Promise.all([
        client.a2aTask.findMany({
          where: page,
          orderBy: [{ statusAt: 'desc' }, { id: 'desc' }],
          take: filter.pageSize + 1,
          omit: { artifacts: filter.withArtifacts !== true },
        }),
        client.a2aTask.count({ where }),
      ]);
      const tasks = rows.slice(0, filter.pageSize).map((row) => toRecord(row as TaskRow));
      const last = tasks.at(-1);
      return {
        tasks,
        totalSize,
        next: rows.length > filter.pageSize && last ? { statusAt: last.statusAt, id: last.id } : null,
      };
    },

    async active(agentRecord) {
      const rows = await client.a2aTask.findMany({
        where: { agentRecord, state: { in: RESUMABLE } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toRecord);
    },

    async update(agentRecord, id, expectedVersion, patch: TaskPatch, message?: Message) {
      if (!TASK_ID_PATTERN.test(id)) throw notFound();
      try {
        const row = message
          ? await client.$transaction(async (tx) => {
              const updated = await updateRow(tx, agentRecord, id, expectedVersion, patch);
              await tx.a2aMessage.create({ data: messageRow(id, message) });
              return updated;
            })
          : await updateRow(client, agentRecord, id, expectedVersion, patch);
        return toRecord(row);
      } catch (error) {
        if (prismaCode(error) !== 'P2025') throw error;
        const current = await client.a2aTask.findFirst({ where: { id, agentRecord }, select: { id: true } });
        throw current ? new TaskStoreError('version', 'görev başka bir güncellemeyle değişti') : notFound();
      }
    },

    async appendMessage(taskId, message, options) {
      if (!TASK_ID_PATTERN.test(taskId)) throw notFound();
      const max = options?.maxMessages;
      try {
        if (max === undefined) {
          await client.a2aMessage.create({ data: messageRow(taskId, message) });
          return true;
        }
        return await client.$transaction(async (tx) => {
          const duplicate = await tx.a2aMessage.findUnique({
            where: { taskId_messageId: { taskId, messageId: message.messageId } },
            select: { id: true },
          });
          if (duplicate) return false;
          if ((await tx.a2aMessage.count({ where: { taskId } })) >= max) {
            throw new TaskStoreError('message-limit', `görevin geçmişi ${max} mesajla dolu`);
          }
          await tx.a2aMessage.create({ data: messageRow(taskId, message) });
          return true;
        });
      } catch (error) {
        if (prismaCode(error) === 'P2002') return false;
        if (prismaCode(error) === 'P2003') throw notFound();
        throw error;
      }
    },

    async message(taskId, messageId) {
      if (!TASK_ID_PATTERN.test(taskId)) return null;
      const row = await client.a2aMessage.findUnique({
        where: { taskId_messageId: { taskId, messageId } },
        select: { content: true },
      });
      return row ? (row.content as Message) : null;
    },

    async history(taskId, limit) {
      if (limit === 0 || !TASK_ID_PATTERN.test(taskId)) return [];
      const rows = await client.a2aMessage.findMany({
        where: { taskId },
        orderBy: { id: limit === undefined ? 'asc' : 'desc' },
        ...(limit === undefined ? {} : { take: limit }),
        select: { content: true },
      });
      const ordered = limit === undefined ? rows : rows.reverse();
      return ordered.map((row) => row.content as Message);
    },
  };
}
