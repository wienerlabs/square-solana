// İş açma ve fonlama (FE-06, akışın 3. adımı): square_escrow `create_job` ve `fund_job` (BC-22). Program
// kimlikleri escrow'un config hesabından okunur (`EscrowConfig.{registry,policy,verifier}_program`,
// program arayüzü §4); ortamda yalnızca escrow'unki gerekir. Tx'ler SDK'nın akışıyla kurulur.
import { Program } from '@anchor-lang/core';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import {
  createSquareClient,
  SQUARE_IDLS,
  specHashing,
  type AgentRecordAccount,
  type ScreeningRecordAccount,
  type SquareClient,
  type SquareEscrowContract,
} from '@squaresdk/solana-sdk';
import { escrowConfigAddress } from './idl-pda';
import { programErrorMessage } from './program-error';

export interface EscrowSetup {
  client: SquareClient;
  registryProgram: PublicKey;
  policyProgram: PublicKey;
  minChallengePeriod: bigint;
  maxChallengePeriod: bigint;
  /** 0: Travel Rule eşiği kapalı (BC-34). */
  travelRuleThreshold: bigint;
  /** Finalize'ı tetikleyenin payı, baz puan (`EscrowParams.keeper_fee_bps`). */
  keeperFeeBps: number;
}

export type EscrowSetupLookup = { state: 'uninitialized'; config: PublicKey } | { state: 'ready'; setup: EscrowSetup };

/** Escrow config'i ve ondan kurulan SDK istemcisi; config yoksa `uninitialized`. */
export async function readEscrowSetup(connection: Connection, escrowProgramId: PublicKey): Promise<EscrowSetupLookup> {
  const config = escrowConfigAddress(escrowProgramId);
  const escrow = new Program<SquareEscrowContract>(
    { ...SQUARE_IDLS.escrow, address: escrowProgramId.toBase58() },
    { connection },
  );
  const account = await escrow.account.escrowConfig.fetchNullable(config);
  if (!account) return { state: 'uninitialized', config };
  const client = createSquareClient({
    connection,
    commitment: 'confirmed',
    programIds: {
      registry: account.registryProgram,
      policy: account.policyProgram,
      verifier: account.verifierProgram,
      escrow: escrowProgramId,
    },
  });
  const big = (value: { toString(): string }) => BigInt(value.toString());
  return {
    state: 'ready',
    setup: {
      client,
      registryProgram: account.registryProgram,
      policyProgram: account.policyProgram,
      minChallengePeriod: big(account.params.minChallengePeriod),
      maxChallengePeriod: big(account.params.maxChallengePeriod),
      travelRuleThreshold: big(account.params.travelRuleThreshold),
      keeperFeeBps: account.params.keeperFeeBps,
    },
  };
}

export type AgentRef = { ok: true; agentRecord: PublicKey } | { ok: false; error: string };

/**
 * Agent'ın kayıt adresi: did:aip v2 Solana DID'i ya da doğrudan `AgentRecord` adresi. DID bu ağın ve
 * escrow'un okuduğu registry'nin olmalı; başka registry'nin agent'ı `AgentNotRegistered` alır.
 */
export function parseAgentRef(input: string, context: { chainRef: string; registryProgram: PublicKey }): AgentRef {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'Enter the agent’s DID or record address.' };
  if (!text.startsWith('did:')) {
    try {
      const address = new PublicKey(text);
      if (address.toBase58() === text) return { ok: true, agentRecord: address };
    } catch {
      // DID değil, adres de değil.
    }
    return { ok: false, error: 'Not a did:aip DID or a Solana address.' };
  }
  let parsed: ReturnType<typeof squareIdentity.parseDidAip>;
  try {
    parsed = squareIdentity.parseDidAip(text);
  } catch {
    return { ok: false, error: 'This is not a valid did:aip identifier.' };
  }
  if (parsed.version !== 2 || parsed.namespace !== 'solana')
    return { ok: false, error: 'Only did:aip v2 Solana agents can take Square jobs.' };
  if (parsed.chainRef !== context.chainRef) return { ok: false, error: 'The DID is on another network.' };
  if (parsed.registry !== context.registryProgram.toBase58())
    return { ok: false, error: 'The DID names a registry this escrow does not read.' };
  return { ok: true, agentRecord: new PublicKey(parsed.agentRecord) };
}

export interface AgentSummary {
  agentId: string;
  owner: PublicKey;
  wallet: PublicKey;
  status: 'active' | 'inactive' | 'deregistered';
  agentCardUri: string;
}

type RegistryAccountName = 'agentRecord' | 'screeningRecord';
type RegistryAccount<K extends RegistryAccountName> = K extends 'agentRecord'
  ? AgentRecordAccount
  : ScreeningRecordAccount;

/**
 * Okunmuş hesabı registry'nin coder'ıyla çözer. Hesap yoksa, registry'ye ait değilse ya da bu türde
 * değilse (discriminator / düzen) null.
 */
export function decodeRegistryAccount<K extends RegistryAccountName>(
  setup: Pick<EscrowSetup, 'client' | 'registryProgram'>,
  name: K,
  info: AccountInfo<Buffer> | null,
): RegistryAccount<K> | null {
  if (!info || !info.owner.equals(setup.registryProgram)) return null;
  try {
    return setup.client.registry.program.coder.accounts.decode(name, info.data) as RegistryAccount<K>;
  } catch {
    return null;
  }
}

/** Hesabı tek istekle okuyup çözer; ağ hatası "kayıt yok" sayılmaz, fırlatılır. */
async function readRegistryAccount<K extends RegistryAccountName>(
  setup: EscrowSetup,
  name: K,
  address: PublicKey,
): Promise<RegistryAccount<K> | null> {
  const info = await setup.client.registry.program.provider.connection.getAccountInfo(address);
  return decodeRegistryAccount(setup, name, info);
}

/** Agent kaydı; hesap yoksa ya da registry'nin `AgentRecord`'u değilse null. */
export async function readAgent(setup: EscrowSetup, agentRecord: PublicKey): Promise<AgentSummary | null> {
  const record = await readRegistryAccount(setup, 'agentRecord', agentRecord);
  if (!record) return null;
  return {
    agentId: record.agentId,
    owner: record.owner,
    wallet: record.wallet,
    status: Object.keys(record.status)[0] as AgentSummary['status'],
    agentCardUri: record.agentCardUri,
  };
}

export type SpecParse =
  { ok: true; spec: Record<string, unknown>; canonical: string; hash: Uint8Array } | { ok: false; error: string };

/** İş tanımı: JSON nesnesi; hash'i RFC 8785 kanonik biçiminin SHA-256'sı (A2A, docs/design/a2a.md §4). */
export function parseSpec(text: string): SpecParse {
  if (text.trim() === '') return { ok: false, error: 'Write the job specification.' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${(error as Error).message}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { ok: false, error: 'The specification must be a JSON object.' };
  try {
    return {
      ok: true,
      spec: value as Record<string, unknown>,
      canonical: specHashing.canonicalizeSpec(value),
      hash: specHashing.specHash(value),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export type ScreeningState =
  { state: 'missing' } | { state: 'clear' | 'expired' | 'flagged'; expiresAt: number; screenedAt: number };

/**
 * Cüzdanın screening durumu, escrow'un `fund_job`'daki kuralıyla (`square_common::screening`): kayıt
 * yoksa `missing`, işaretliyse süresinden bağımsız `flagged`, `expires_at <= now` ise `expired`.
 */
export async function readScreening(setup: EscrowSetup, wallet: PublicKey, now: number): Promise<ScreeningState> {
  const record = await readRegistryAccount(setup, 'screeningRecord', setup.client.pda.screeningRecord(wallet)[0]);
  if (!record) return { state: 'missing' };
  return screeningState(
    {
      flagged: 'flagged' in record.status,
      expiresAt: record.expiresAt.toNumber(),
      screenedAt: record.screenedAt.toNumber(),
    },
    now,
  );
}

export function screeningState(
  record: { flagged: boolean; expiresAt: number; screenedAt: number },
  now: number,
): ScreeningState {
  const { expiresAt, screenedAt } = record;
  if (record.flagged) return { state: 'flagged', expiresAt, screenedAt };
  if (expiresAt <= now) return { state: 'expired', expiresAt, screenedAt };
  return { state: 'clear', expiresAt, screenedAt };
}

export const SCREENING_TEXT: Readonly<Record<ScreeningState['state'], string>> = {
  clear: 'Clear',
  missing: 'Not screened',
  expired: 'Screening expired',
  flagged: 'Flagged',
};

/** Fonlamayı kapatan screening sebebi; iki taraf da temizse null. */
export function screeningBlock(institution: ScreeningState, agent: ScreeningState): string | null {
  const problems: string[] = [];
  const describe = (who: string, s: ScreeningState) => {
    if (s.state === 'missing') problems.push(`The ${who} wallet has no sanctions screening yet.`);
    if (s.state === 'expired') problems.push(`The ${who} wallet's screening has expired and must be renewed.`);
    if (s.state === 'flagged') problems.push(`The ${who} wallet is flagged by sanctions screening.`);
  };
  describe('institution', institution);
  describe('agent', agent);
  return problems.length > 0
    ? `${problems.join(' ')} Funding needs a clear, unexpired screening for both wallets; the screening service records them.`
    : null;
}

/** Escrow hata kodunun açıklaması; screening kodları için ne yapılacağı da söylenir. */
export function escrowErrorMessage(error: unknown): string | null {
  const message = programErrorMessage(SQUARE_IDLS.escrow, error);
  if (!message) return null;
  if (/ScreeningRequired|ScreeningExpired|ScreeningFlagged/i.test(message)) {
    return `${message}. Funding was refused by sanctions screening; the job stays open and can be funded once both wallets are screened clear.`;
  }
  if (/TravelRuleCommitmentRequired/.test(message)) {
    return `${message}. The job stays open: bind the Travel Rule commitment, then fund it.`;
  }
  return message;
}

/** Saniye cinsinden süreyi okunur yazar: 86400 → "1 d", 5400 → "1 h 30 min". */
export function formatDuration(seconds: bigint): string {
  const parts: string[] = [];
  let rest = seconds;
  for (const [unit, size] of [
    ['d', 86_400n],
    ['h', 3_600n],
    ['min', 60n],
    ['s', 1n],
  ] as const) {
    if (rest >= size) {
      parts.push(`${rest / size} ${unit}`);
      rest %= size;
    }
  }
  return parts.length > 0 ? parts.join(' ') : '0 s';
}

/** Challenge süresi (dakika) → saniye; config sınırlarının dışındaysa hata. */
export function parseChallengePeriod(
  minutes: string,
  bounds: { min: bigint; max: bigint },
): { ok: true; seconds: bigint } | { ok: false; error: string } {
  if (!/^[1-9][0-9]*$/.test(minutes.trim())) return { ok: false, error: 'Enter whole minutes.' };
  const seconds = BigInt(minutes.trim()) * 60n;
  if (seconds < bounds.min || seconds > bounds.max) {
    return {
      ok: false,
      error: `Must be between ${formatDuration(bounds.min)} and ${formatDuration(bounds.max)} (escrow config).`,
    };
  }
  return { ok: true, seconds };
}

/** `datetime-local` değeri (yerel saat) → Unix saniye; geçmişteyse hata. */
export function parseDeadline(local: string, now: number): { ok: true; unix: number } | { ok: false; error: string } {
  if (local === '') return { ok: false, error: 'Choose a deadline.' };
  const ms = new Date(local).getTime();
  if (!Number.isFinite(ms)) return { ok: false, error: 'Not a valid date and time.' };
  const unix = Math.floor(ms / 1000);
  if (unix <= now) return { ok: false, error: 'The deadline must be in the future.' };
  return { ok: true, unix };
}
