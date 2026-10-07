// Agent card barındırma (`putAgentCard`, `getWellKnownAgentCard`). Kart, kayıt sahibi tarafından yazılır:
// - Kayıt indexlenmişse çağıran `AgentRecord.owner`'dır.
// - Kart kayıttan önce yüklenir (8 adımın 2.si): çağıran `agentId`'yi (`register_agent`'ın `agent_id`'si) verir;
//   yol, çağıranın cüzdanı ve bu kimlikle türetilen PDA'ya (`["agent", owner, agent_id]`) eşit olmalıdır.
// - Sahip bir smart account'un vault'uysa multisig'in `Initiate` yetkili üyesi `X-Square-Smart-Account` başlığıyla
//   yazar; kayıttan önce yol vault ve `agentId` ile türetilir (caller.ts).
// Kartın `registrations`'ı bu kaydı (`solana:<chain-ref>:<registry>` + AgentRecord) içermelidir. Saklanan
// baytlar kartın RFC 8785 kanonik JSON'udur; `agentCardHash` bu baytların SHA-256'sı, `agentCardUri` A2A keşif
// yoludur. İkisi `register_agent` / `update_agent`'ın argümanlarıdır.
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@squaresdk/solana-db';
import { specHashing, type SquarePda } from '@squaresdk/solana-sdk';
import { AgentCardSchema, type AgentCard, type AgentCardHosting } from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import type { Caller, CallerAuthority } from './caller.js';
import { badRequest, forbidden, parse } from './http.js';

export interface CardService {
  put(params: {
    caller: Caller;
    agentRecord: string;
    agentId: string | null;
    card: unknown;
  }): Promise<AgentCardHosting>;
  /** Barındırılan kartın baytları; yoksa null. */
  hosted(agentRecord: string): Promise<Buffer | null>;
}

export const cardPath = (agentRecord: string) => `/a/${agentRecord}/.well-known/agent-card.json`;

/** Kartın arama etiketleri (`listAgents?skill=`): beceri kimlikleri ve etiketleri. */
const skillsOf = (card: AgentCard) => [...new Set(card.skills.flatMap((skill) => [skill.id, ...skill.tags]))];

export function createCardService(deps: {
  db: PrismaClient;
  pda: SquarePda;
  registryProgramId: PublicKey;
  chainRef: string;
  publicBaseUrl: string;
  callers: CallerAuthority;
  clock?: () => number;
}): CardService {
  const { db } = deps;
  const clock = deps.clock ?? Date.now;
  const registry = `solana:${deps.chainRef}:${deps.registryProgramId.toBase58()}`;

  async function authorize(caller: Caller, agentRecord: string, agentId: string | null) {
    const agent = await db.agent.findUnique({ where: { address: agentRecord } });
    if (agent) {
      if (!(await deps.callers.actsFor(caller, agent.owner))) throw forbidden('kartı yalnızca kaydın sahibi yazabilir');
      return agent;
    }
    if (agentId === null) throw badRequest('kayıt henüz yok: agentId (register_agent agent_id) gerekli');
    // Kayıttan önce sahip yoldan bulunur: çağıranın cüzdanı ya da başlıktaki smart account'un vault'u.
    let owner: string | undefined;
    try {
      owner = [caller.wallet, caller.smartAccount?.vault]
        .filter((candidate): candidate is string => candidate !== undefined)
        .find((candidate) => deps.pda.agentRecord(new PublicKey(candidate), agentId)[0].toBase58() === agentRecord);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
    if (owner === undefined || !(await deps.callers.actsFor(caller, owner))) {
      throw forbidden(
        "agentRecord, çağıranın cüzdanı (ya da smart account vault'u) ve agentId ile türetilen kayıt değil",
      );
    }
    return null;
  }

  return {
    async put({ caller, agentRecord, agentId, card }) {
      const parsed = parse(AgentCardSchema, card, 'agent card');
      if (!parsed.registrations.some((entry) => entry.agentRegistry === registry && entry.agentId === agentRecord)) {
        throw badRequest(`registrations bu kaydı içermeli: { agentRegistry: ${registry}, agentId: ${agentRecord} }`);
      }
      const agent = await authorize(caller, agentRecord, agentId);
      const raw = Buffer.from(specHashing.canonicalizeSpec(parsed), 'utf8');
      const contentHash = createHash('sha256').update(raw).digest('hex');
      const uri = `${deps.publicBaseUrl}${cardPath(agentRecord)}`;
      const verified = agent?.agentCardHash === contentHash;
      const row = {
        source: 'hosted' as const,
        uri,
        raw,
        contentHash,
        content: parsed,
        skills: skillsOf(parsed),
        verified,
        verifiedAt: verified ? new Date(clock()) : null,
      };
      await db.agentCard.upsert({ where: { agentRecord }, create: { agentRecord, ...row }, update: row });
      return { agentCardUri: uri, agentCardHash: contentHash };
    },
    async hosted(agentRecord) {
      const row = await db.agentCard.findUnique({ where: { agentRecord } });
      return row?.source === 'hosted' ? Buffer.from(row.raw) : null;
    },
  };
}
