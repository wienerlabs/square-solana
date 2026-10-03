// TaskStore'un Postgres uygulaması: a2a_tasks ve a2a_messages (db/prisma/schema.prisma, BE-17). db
// paketine yalnızca tip olarak bağlıdır; istemci (`createDatabaseClient`) çağırandan gelir.
import type { A2aTaskModel, Prisma, PrismaClient } from '@squaresdk/solana-db';
import { TERMINAL_TASK_STATES, type Artifact, type Message } from '@squaresdk/solana-types';
import {
  TaskStoreError,
  type ListFilter,
  type ListResult,
  type NewTask,
  type TaskPatch,
  type TaskRecord,
  type TaskStore,
} from './store.js';

const TERMINAL = [...TERMINAL_TASK_STATES];
/** Görev kimlikleri UUID'dir; başka biçimdeki kimlik için görev yoktur. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const prismaCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;

function toRecord(row: A2aTaskModel): TaskRecord {
  return {
    id: row.id,
    agentRecord: row.agentRecord,
    caller: row.caller,
    contextId: row.contextId,
    job: row.job,
    specHash: row.specHash,
    state: row.state,
    statusMessage: isMessage(row.statusMessage) ? row.statusMessage : null,
    statusAt: row.statusAt,
    artifacts: row.artifacts as Artifact[],
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
    if (row.createHash !== task.createHash) {
      throw new TaskStoreError('message-id', 'aynı mesaj kimliği farklı içerikle kullanıldı');
    }
    return { task: toRecord(row), created: false };
  }

  async function create(task: NewTask) {
    return client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`a2a:${task.agentRecord}:${task.job}`}))`;
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
          contextId: task.contextId,
          job: task.job,
          specHash: task.specHash,
          state: 'TASK_STATE_SUBMITTED',
          statusAt: task.statusAt,
          artifacts: json([]),
          createMessageId: task.message.messageId,
          createHash: task.createHash,
          jobStatus: task.jobStatus,
          jobSlot: task.jobSlot === null ? null : BigInt(task.jobSlot),
          messages: {
            create: { messageId: task.message.messageId, role: task.message.role, content: json(task.message) },
          },
        },
      });
      return { task: toRecord(row), created: true };
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
        throw error;
      }
    },

    async get(agentRecord, id) {
      if (!UUID.test(id)) return null;
      const row = await client.a2aTask.findFirst({ where: { id, agentRecord } });
      return row ? toRecord(row) : null;
    },

    async list(agentRecord, caller, filter: ListFilter): Promise<ListResult> {
      const where: Prisma.A2aTaskWhereInput = {
        agentRecord,
        caller,
        ...(filter.contextId ? { contextId: filter.contextId } : {}),
        ...(filter.state ? { state: filter.state } : {}),
        ...(filter.statusAfter ? { statusAt: { gte: filter.statusAfter } } : {}),
      };
      const page = filter.after
        ? {
            AND: [
              where,
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
        }),
        client.a2aTask.count({ where }),
      ]);
      const tasks = rows.slice(0, filter.pageSize).map(toRecord);
      const last = tasks.at(-1);
      return {
        tasks,
        totalSize,
        next: rows.length > filter.pageSize && last ? { statusAt: last.statusAt, id: last.id } : null,
      };
    },

    async update(agentRecord, id, expectedVersion, patch: TaskPatch) {
      if (!UUID.test(id)) throw new TaskStoreError('not-found', 'görev yok');
      try {
        const row = await client.a2aTask.update({
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
        return toRecord(row);
      } catch (error) {
        if (prismaCode(error) !== 'P2025') throw error;
        const current = await client.a2aTask.findFirst({ where: { id, agentRecord }, select: { id: true } });
        throw current
          ? new TaskStoreError('version', 'görev başka bir güncellemeyle değişti')
          : new TaskStoreError('not-found', 'görev yok');
      }
    },

    async appendMessage(taskId, message) {
      if (!UUID.test(taskId)) throw new TaskStoreError('not-found', 'görev yok');
      try {
        await client.a2aMessage.create({
          data: { taskId, messageId: message.messageId, role: message.role, content: json(message) },
        });
        return true;
      } catch (error) {
        if (prismaCode(error) === 'P2002') return false;
        throw error;
      }
    },

    async history(taskId, limit) {
      if (limit === 0 || !UUID.test(taskId)) return [];
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
