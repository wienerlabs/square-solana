// Arbitrator kuyruğu ve oyu (BE-22, ADR 0016, ADR 0028).
// - Kuyruk: indexer'ın dispute aynasında açık (`disputed`) dispute'lar, son tarihi en yakın önce. Oylar
//   `DisputeVote` (onay) ve `DisputeVoteRejected` (ret) event'lerinden (dispute'un son açılışından sonrakiler);
//   arbitrator'ın bekleyen öneriye oyu aynadaki onay ve ret maskeleriyle set sürümünden. Set sürümü config'tekinden
//   eskiyse sonraki oy sayımı sıfırlar, o yüzden arbitrator oy vermemiş sayılır. Ret öneriyi sıfırladıysa
//   maskeler de sıfırdır.
// - Oy: zincirdeki job ve config'e göre ön denetim, sonra genel tx hazırlayıcıyla `resolve_dispute`. Bekleyen
//   öneriden farklı bir karar ret oyudur. Kesin kural programdadır; hazırlayıcı tx'i simüle eder.
import type { Idl } from '@anchor-lang/core';
import type { PrismaClient } from '@squaresdk/solana-db';
import type { ReadApi } from '@squaresdk/solana-indexer/read';
import { toIdlJson, type SquareClient } from '@squaresdk/solana-sdk';
import {
  ArbitrationQueueItemSchema,
  DisputeVoteRecordSchema,
  type ArbitrationQueueItem,
  type DisputeResolution,
  type DisputeVoteRecord,
  type DisputeVoteRequest,
  type UnsignedTx,
} from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../http.js';
import type { TxBuilder } from '../tx.js';
import type { Arbitrators } from './arbitrators.js';
import { evidenceOf } from './evidence.js';

export interface ArbitrationService {
  queue(
    wallet: string,
    page: { page: number; limit: number },
  ): Promise<{ items: ArbitrationQueueItem[]; total: number; page: number; limit: number }>;
  prepareVote(params: { wallet: string; job: string; request: DisputeVoteRequest }): Promise<UnsignedTx>;
}

/** Oyun çağıranın bekleyen öneriye oyu: aynı sürümde onay ya da ret biti varsa oy verilmiş. */
export const hasVoted = (
  dispute: { approvalMask: number; rejectionMask: number; arbitratorSetVersion: number },
  index: number,
  version: number,
) => dispute.arbitratorSetVersion === version && ((dispute.approvalMask | dispute.rejectionMask) & (1 << index)) !== 0;

type VotePayload = {
  arbitrator: string;
  resolution: unknown;
  approvalCount?: number;
  rejectionCount?: number;
  proposalReset?: boolean;
};

function voteRecord(name: string, data: VotePayload) {
  return name === 'DisputeVote'
    ? { kind: 'approve', approvalCount: data.approvalCount, rejectionCount: null, proposalReset: false }
    : { kind: 'reject', approvalCount: null, rejectionCount: data.rejectionCount, proposalReset: data.proposalReset };
}

export function createArbitrationService(deps: {
  db: PrismaClient;
  read: ReadApi;
  client: SquareClient;
  tx: TxBuilder;
  arbitrators: Arbitrators;
  clock?: () => number;
}): ArbitrationService {
  const { db, read, client, arbitrators } = deps;
  const clock = deps.clock ?? Date.now;
  const escrowIdl = client.escrow.program.idl as unknown as Idl;
  const nowSeconds = () => Math.floor(clock() / 1000);

  async function requireArbitrator(wallet: string) {
    const set = await arbitrators.get();
    const index = set.arbitrators.indexOf(wallet);
    if (index === -1) throw forbidden('çağıran aktif arbitrator değil');
    return { set, index };
  }

  /** Dispute'un son açılışından (`DisputeRaised`) sonraki oylar, eskiden yeniye. */
  async function votesOf(job: string): Promise<DisputeVoteRecord[]> {
    const raised = await db.chainEvent.findFirst({
      where: { job, name: 'DisputeRaised' },
      orderBy: [{ slot: 'desc' }, { id: 'desc' }],
      select: { slot: true },
    });
    const rows = await db.chainEvent.findMany({
      where: {
        job,
        name: { in: ['DisputeVote', 'DisputeVoteRejected'] },
        ...(raised ? { slot: { gte: raised.slot } } : {}),
      },
      orderBy: [{ slot: 'asc' }, { instructionIndex: 'asc' }, { eventIndex: 'asc' }],
    });
    return rows.map((row) => {
      const data = (row.payload as { data: VotePayload }).data;
      return DisputeVoteRecordSchema.parse({
        ...voteRecord(row.name, data),
        arbitrator: data.arbitrator,
        resolution: data.resolution,
        signature: row.signature,
        slot: Number(row.slot),
        blockTime: row.blockTime === null ? null : Number(row.blockTime),
      });
    });
  }

  return {
    async queue(wallet, page) {
      const { set, index } = await requireArbitrator(wallet);
      const where = { jobStatus: 'disputed' as const };
      const [rows, total] = await Promise.all([
        db.dispute.findMany({
          where,
          orderBy: [{ deadline: 'asc' }, { job: 'asc' }],
          skip: (page.page - 1) * page.limit,
          take: page.limit,
        }),
        db.dispute.count({ where }),
      ]);
      const now = nowSeconds();
      const items = await Promise.all(
        rows.map(async (row) => {
          const [dispute, votes, evidence] = await Promise.all([
            read.getDispute(row.job),
            votesOf(row.job),
            evidenceOf(db, row.job),
          ]);
          const voted = hasVoted(
            {
              approvalMask: row.approvalMask,
              rejectionMask: row.rejectionMask,
              arbitratorSetVersion: Number(row.arbitratorSetVersion),
            },
            index,
            set.version,
          );
          return ArbitrationQueueItemSchema.parse({
            dispute,
            votes,
            hasVoted: voted,
            canVote: !voted && now < Number(row.deadline),
            threshold: set.threshold,
            evidence,
          });
        }),
      );
      return { items, total, ...page };
    },

    async prepareVote({ wallet, job, request }) {
      const { set, index } = await requireArbitrator(wallet);
      const vote = request.resolution;
      if (vote.kind === 'pending') throw badRequest('pending bir oy değil');
      let account;
      try {
        account = await client.escrow.fetch('job', new PublicKey(job));
      } catch (error) {
        throw new HttpError(503, 'rpc_unavailable', 'job zincirden okunamadı', null, null, error);
      }
      if (!account) throw notFound('job zincirde yok');
      const state = toIdlJson(escrowIdl, { defined: { name: 'job' } }, account) as {
        status: string;
        amount: string;
        disputeRejectionMask: number;
        dispute: {
          deadline: number;
          approvalMask: number;
          arbitratorSetVersion: number;
          resolution: DisputeResolution;
        };
      };
      if (state.status !== 'disputed') throw conflict(`job ${state.status} durumunda; açık dispute yok`);
      if (nowSeconds() >= state.dispute.deadline) {
        throw conflict('dispute’un son tarihi geçti; yalnızca lapse_dispute çalışır', {
          deadline: state.dispute.deadline,
        });
      }
      if (vote.kind === 'split' && BigInt(vote.agentAmount) > BigInt(state.amount)) {
        throw badRequest('split.agentAmount escrow tutarını aşamaz', { amount: state.amount });
      }
      // Aynı set sürümünde sayım sürer; eski sürümde bir sonraki oy sayımı sıfırlar (ADR 0016 madde 2). Bekleyen
      // öneriden farklı oy ret sayılır (ADR 0028 madde 4).
      const tally = { ...state.dispute, rejectionMask: state.disputeRejectionMask };
      if (hasVoted(tally, index, set.version)) throw conflict('arbitrator bekleyen öneriye oy verdi');
      return deps.tx.prepare({
        call: { program: 'escrow', instruction: 'resolveDispute', args: { resolution: vote } },
        // Job PDA kendi alanlarıyla türetildiğinden çözücü onu çözemez; adres istekte.
        accounts: { arbitrator: wallet, job },
        feePayer: request.feePayer ?? wallet,
        computeUnitPrice: request.computeUnitPrice,
      });
    },
  };
}
