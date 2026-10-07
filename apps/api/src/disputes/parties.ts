// Dispute tarafları: kanıtı yükleyen ve okuyan cüzdanın rolü.
// - Kurum: job'un `institution`'ı (fonlayan cüzdan). Job bir Squads vault'una aitse (kurumun bağlı
//   `multisig_vault`'u) vault mesaj imzalayamaz; multisig'te öneri açabilen (`Initiate`) üyeler kurum sayılır.
// - Agent: job'un agent cüzdanı ya da agent kaydının sahibi.
// - Arbitrator: escrow config'indeki aktif set.
// Bir cüzdan birden çok role uyuyorsa ilk uyan rol (kurum, agent, arbitrator) geçerlidir.
import type { EvidenceRole, PrismaClient } from '@squaresdk/solana-db';
import type { Connection } from '@solana/web3.js';
import { isMultisigInitiator } from '../squads.js';
import type { Arbitrators } from './arbitrators.js';

export interface JobParties {
  readonly address: string;
  readonly institution: string;
  readonly agentRecord: string;
  readonly agentWallet: string;
}

export interface Parties {
  roleOf(wallet: string, job: JobParties): Promise<EvidenceRole | null>;
}

const ROLES: readonly EvidenceRole[] = ['institution', 'agent', 'arbitrator'];

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
    async roleOf(wallet, job) {
      if (wallet === job.institution) return 'institution';
      const checks = await Promise.allSettled([
        isVaultInitiator(wallet, job),
        isAgent(wallet, job),
        deps.arbitrators.indexOf(wallet).then((index) => index !== null),
      ]);
      const matched = ROLES.find((_, i) => {
        const check = checks[i]!;
        return check.status === 'fulfilled' && check.value;
      });
      if (matched) return matched;
      const failed = checks.find((check): check is PromiseRejectedResult => check.status === 'rejected');
      if (failed) throw failed.reason;
      return null;
    },
  };
}
