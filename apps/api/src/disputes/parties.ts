// Dispute tarafları: kanıtı yükleyen ve okuyan cüzdanın rolü.
// - Kurum: job'un `institution`'ı (fonlayan cüzdan). Job bir Squads vault'una aitse (kurumun bağlı
//   `multisig_vault`'u) vault mesaj imzalayamaz; multisig'te öneri açabilen (`Initiate`) üyeler kurum sayılır.
// - Agent: job'un agent cüzdanı ya da agent kaydının sahibi.
// - Arbitrator: escrow config'indeki aktif set.
// Bir cüzdan birden çok role uyuyorsa ilk uyan rol (kurum, agent, arbitrator) geçerlidir. Üstteki denetim hata
// verirse okumada alttaki rol geçerlidir; yüklemede yalnızca kalıcı hatada (403), geçici hata (503) yükselir.
import type { EvidenceRole, PrismaClient } from '@squaresdk/solana-db';
import type { Connection } from '@solana/web3.js';
import { HttpError } from '../http.js';
import { isMultisigInitiator } from '../squads.js';
import type { Arbitrators } from './arbitrators.js';

export interface JobParties {
  readonly address: string;
  readonly institution: string;
  readonly agentRecord: string;
  readonly agentWallet: string;
}

export type RoleUse = 'read' | 'upload';

export interface Parties {
  roleOf(wallet: string, job: JobParties, use: RoleUse): Promise<EvidenceRole | null>;
}

const lasting = (error: unknown) => error instanceof HttpError && error.status === 403;

export function createParties(deps: { db: PrismaClient; connection: Connection; arbitrators: Arbitrators }): Parties {
  const { db } = deps;

  async function isVaultInitiator(wallet: string, job: JobParties): Promise<boolean> {
    const institution = await db.institution.findFirst({ where: { multisigVault: job.institution } });
    const multisig = (institution?.account as { multisig?: string | null } | undefined)?.multisig ?? null;
    return multisig !== null && isMultisigInitiator(deps.connection, multisig, wallet);
  }

  async function isAgent(wallet: string, job: JobParties): Promise<boolean> {
    if (wallet === job.agentWallet) return true;
    const agent = await db.agent.findUnique({ where: { address: job.agentRecord }, select: { owner: true } });
    return agent?.owner === wallet;
  }

  return {
    async roleOf(wallet, job, use) {
      if (wallet === job.institution) return 'institution';
      const checks: [EvidenceRole, () => Promise<boolean>][] = [
        ['institution', () => isVaultInitiator(wallet, job)],
        ['agent', () => isAgent(wallet, job)],
        ['arbitrator', async () => (await deps.arbitrators.indexOf(wallet)) !== null],
      ];
      const failures: unknown[] = [];
      for (const [role, check] of checks) {
        try {
          if (await check()) return role;
        } catch (error) {
          if (use === 'upload' && !lasting(error)) throw error;
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
      return null;
    },
  };
}
