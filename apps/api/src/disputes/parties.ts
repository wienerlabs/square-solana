// Dispute tarafları: kanıtı yükleyen ve okuyan çağıranın rolü.
// - Kurum: job'un `institution`'ı (fonlayan cüzdan). Job bir Squads vault'una aitse (kurumun bağlı
//   `multisig_vault`'u) vault mesaj imzalayamaz; multisig'te öneri açabilen (`Initiate`) üyeler kurum sayılır.
// - Agent: job'un agent cüzdanı ya da agent kaydının sahibi.
// - Arbitrator: escrow config'indeki aktif set; arbitrator cüzdanıyla girer.
// Kurumun ya da agent'ın adresi bir smart account'un vault'uysa üye `X-Square-Smart-Account` başlığıyla o taraf
// sayılır (caller.ts). Bir cüzdan birden çok role uyuyorsa ilk uyan rol (kurum, agent, arbitrator) geçerlidir.
import type { EvidenceRole, PrismaClient } from '@squaresdk/solana-db';
import type { Connection } from '@solana/web3.js';
import { createCallerAuthority, type Caller } from '../caller.js';
import { isMultisigInitiator } from '../squads.js';
import type { Arbitrators } from './arbitrators.js';

export interface JobParties {
  readonly address: string;
  readonly institution: string;
  readonly agentRecord: string;
  readonly agentWallet: string;
}

export interface Parties {
  roleOf(caller: Caller, job: JobParties): Promise<EvidenceRole | null>;
}

export function createParties(deps: { db: PrismaClient; connection: Connection; arbitrators: Arbitrators }): Parties {
  const { db } = deps;
  const callers = createCallerAuthority({ connection: deps.connection });

  async function isInstitution(caller: Caller, job: JobParties): Promise<boolean> {
    if (await callers.actsFor(caller, job.institution)) return true;
    const institution = await db.institution.findFirst({ where: { multisigVault: job.institution } });
    const multisig = (institution?.account as { multisig?: string | null } | undefined)?.multisig ?? null;
    return multisig !== null && isMultisigInitiator(deps.connection, multisig, caller.wallet);
  }

  async function isAgent(caller: Caller, job: JobParties): Promise<boolean> {
    if (await callers.actsFor(caller, job.agentWallet)) return true;
    const agent = await db.agent.findUnique({ where: { address: job.agentRecord }, select: { owner: true } });
    return callers.actsFor(caller, agent?.owner);
  }

  return {
    async roleOf(caller, job) {
      if (await isInstitution(caller, job)) return 'institution';
      if (await isAgent(caller, job)) return 'agent';
      if ((await deps.arbitrators.indexOf(caller.wallet)) !== null) return 'arbitrator';
      return null;
    },
  };
}
