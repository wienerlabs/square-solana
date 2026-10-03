// Square bağlaması (docs/design/a2a.md §4): görevi açan mesaj zincirdeki bir job'a bağlanır. Job bu
// agent'a ait, açık ya da fonlanmış olmalı ve mesajdaki spec hash'i job'unkiyle eşleşmeli. Zincir
// okuması `JobSource` üzerindendir; ürün uygulaması SDK ile escrow `Job` hesabını okur.
import { PublicKey } from '@solana/web3.js';
import { specHashing, type SquareClient } from '@squaresdk/solana-sdk';
import { SquareTaskMetadataSchema, type JobStatus, type Message } from '@squaresdk/solana-types';
import { errors } from './errors.js';

export interface JobFacts {
  address: string;
  status: JobStatus;
  agentRecord: string;
  institution: string;
  specHash: string;
  /** Hesabın okunduğu slot. */
  slot: number | null;
}

export interface JobSource {
  getJob(address: string): Promise<JobFacts | null>;
}

interface JobAccount {
  institution: PublicKey;
  agentRecord: PublicKey;
  specHash: number[];
  status: Record<string, unknown>;
}

interface JobNamespace {
  fetchNullableAndContext(address: PublicKey): Promise<{ data: JobAccount | null; context: { slot: number } }>;
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('hex');

/** Escrow `Job` hesabını SDK'nın programı üzerinden okur. */
export function createChainJobSource(client: SquareClient): JobSource {
  const jobs = (client.escrow.program.account as unknown as { job: JobNamespace }).job;
  return {
    async getJob(address) {
      let key: PublicKey;
      try {
        key = new PublicKey(address);
      } catch {
        return null;
      }
      const { data, context } = await jobs.fetchNullableAndContext(key);
      if (!data) return null;
      const [status] = Object.keys(data.status);
      return {
        address: key.toBase58(),
        status: status as JobStatus,
        agentRecord: data.agentRecord.toBase58(),
        institution: data.institution.toBase58(),
        specHash: hex(data.specHash),
        slot: context.slot,
      };
    },
  };
}

/** Mesajın içerik hash'i (kimlikler hariç, RFC 8785 + SHA-256): aynı mesaj kimliğiyle farklı içerik ayırt edilir. */
export function messageContentHash(message: Message): string {
  return hex(
    specHashing.specHash({
      role: message.role,
      parts: message.parts,
      metadata: message.metadata ?? null,
      extensions: message.extensions ?? [],
      referenceTaskIds: message.referenceTaskIds ?? [],
    }),
  );
}

export interface CreateDecision {
  job: JobFacts;
  specHash: string;
  /** Görevin bağlamı job adresidir. */
  contextId: string;
}

export interface TaskGate {
  admitCreate(message: Message): Promise<CreateDecision>;
}

const OPEN_FOR_TASKS: ReadonlySet<JobStatus> = new Set(['open', 'funded']);
const SquareRefSchema = SquareTaskMetadataSchema.pick({ job: true, specHash: true });

/**
 * Yeni görev kapısı. `message.metadata.square = { job, specHash }` zorunlu; mesajda `data` parçası varsa
 * ilki job spec'idir ve RFC 8785 + SHA-256'sı `specHash` ile eşleşmelidir.
 */
export function createSquareTaskGate(options: { agentRecord: string; jobSource: JobSource }): TaskGate {
  return {
    async admitCreate(message) {
      const ref = SquareRefSchema.safeParse(message.metadata?.square);
      if (!ref.success) {
        throw errors.rejectedParams(
          'SQUARE_METADATA_REQUIRED',
          'message.metadata.square',
          'görevi açan mesaj metadata.square.job ve metadata.square.specHash taşımalı',
        );
      }
      const job = await options.jobSource.getJob(ref.data.job);
      if (!job) throw errors.rejectedParams('JOB_NOT_FOUND', 'message.metadata.square.job', 'job zincirde yok');
      if (job.agentRecord !== options.agentRecord) {
        throw errors.rejectedParams(
          'JOB_NOT_FOR_AGENT',
          'message.metadata.square.job',
          'job bu agent kaydına bağlı değil',
        );
      }
      if (!OPEN_FOR_TASKS.has(job.status)) {
        throw errors.rejectedParams('JOB_NOT_OPEN', 'message.metadata.square.job', 'job açık ya da fonlanmış değil', {
          jobStatus: job.status,
        });
      }
      if (job.specHash !== ref.data.specHash) {
        throw errors.rejectedParams(
          'SPEC_HASH_MISMATCH',
          'message.metadata.square.specHash',
          'spec hash job ile eşleşmiyor',
        );
      }
      const spec = message.parts.find((part) => part.data !== undefined);
      if (spec && hex(specHashing.specHash(spec.data)) !== ref.data.specHash) {
        throw errors.rejectedParams(
          'SPEC_HASH_MISMATCH',
          'message.parts',
          "spec parçasının hash'i specHash ile eşleşmiyor",
        );
      }
      if (message.contextId !== undefined && message.contextId !== job.address) {
        throw errors.rejectedParams('CONTEXT_ID_REJECTED', 'message.contextId', 'görevin bağlamı job adresidir');
      }
      return { job, specHash: ref.data.specHash, contextId: job.address };
    },
  };
}
