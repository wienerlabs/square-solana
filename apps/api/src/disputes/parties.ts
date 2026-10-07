// Dispute tarafları: kanıtı yükleyen ve okuyan çağıranın rolü.
// - Kurum: job'un `institution`'ı (fonlayan cüzdan). Job bir Squads vault'una aitse (kurumun bağlı
//   `multisig_vault`'u) vault mesaj imzalayamaz; multisig'te öneri açabilen (`Initiate`) üyeler kurum sayılır.
// - Agent: job'un agent cüzdanı ya da agent kaydının sahibi.
// - Arbitrator: escrow config'indeki aktif set; arbitrator cüzdanıyla girer.
// Kurumun ya da agent'ın adresi bir smart account'un vault'uysa üye `X-Square-Smart-Account` başlığıyla o taraf
// sayılır (caller.ts). Bir cüzdan birden çok role uyuyorsa ilk uyan rol (kurum, agent, arbitrator) geçerlidir.
// Üstteki denetim hata verirse okumada alttaki rol geçerlidir; yüklemede yalnızca kalıcı hatada (403), geçici hata
// (503) yükselir.
import type { EvidenceRole, PrismaClient } from '@squaresdk/solana-db';
import type { Connection } from '@solana/web3.js';
import { createCallerAuthority, type Caller } from '../caller.js';
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
  roleOf(caller: Caller, job: JobParties, use: RoleUse): Promise<EvidenceRole | null>;
}

const lasting = (error: unknown) => error instanceof HttpError && error.status === 403;

export function createParties(deps: { db: PrismaClient; connection: Connection; arbitrators: Arbitrators }): Parties {
  const { db } = deps;
  const callers = createCallerAuthority({ connection: deps.connection });

  /** Job'un kurumu `set_institution_multisig` ile bağlanmış multisig'in vault'uysa öneri açabilen üye. */
  async function isVaultInitiator(caller: Caller, job: JobParties): Promise<boolean> {
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
    async roleOf(caller, job, use) {
      if (caller.wallet === job.institution) return 'institution';
      const checks: [EvidenceRole, () => Promise<boolean>][] = [
        ['institution', () => callers.actsFor(caller, job.institution)],
        ['institution', () => isVaultInitiator(caller, job)],
        ['agent', () => isAgent(caller, job)],
        ['arbitrator', async () => (await deps.arbitrators.indexOf(caller.wallet)) !== null],
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
