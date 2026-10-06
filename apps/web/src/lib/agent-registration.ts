// Agent kaydı (FE-05, akışın 2. adımı): did:aip v2 Solana profili §4 ve §7.1. Kayıt adresi ve DID tx'ten
// önce hesaplanır (seed'ler creator'ın anahtarını içerir); kart önce yayımlanır, doğrulanır ve kartın
// baytlarının SHA-256'sıyla kaydedilir (§7.1). Kart iki yoldan yayımlanır: agent'ın kendi adresinde (tarayıcı
// indirip doğrular) ya da Square API'de (`putAgentCard`; API şemadan geçmiş kartın RFC 8785 kanonik JSON'unu
// saklar, tarayıcı aynı baytların hash'ini kendisi hesaplar).
import { Program } from '@anchor-lang/core';
import { sha256 } from '@noble/hashes/sha2';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { squareIdentity, type CardFetchOptions } from '@squaresdk/solana-identity';
import { SQUARE_IDLS, specHashing, type SquareRegistryContract } from '@squaresdk/solana-sdk';
import {
  AgentCardSchema,
  type AgentCard,
  type AgentCardHosting,
  type AgentRegistration,
} from '@squaresdk/solana-types';
import { agentRecordAddress } from './idl-pda';
import { programErrorMessage } from './program-error';

/** `agent_id`: `[A-Za-z0-9_-]{1,32}`, değişmez (profil §3.4, §4.1). */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** `agent_card_uri` üst sınırı (registry `AgentCardUriTooLong`). */
export const MAX_CARD_URI_BYTES = 200;

/**
 * Kart indirme sınırları. Yalnızca https (ipfs ağ geçidi yapılandırılmadı); yönlendirme izlenmez.
 * 256 KiB, şemanın izin verdiği en büyük kartlardan (50 beceri) daha geniş tutulmuş bir sınırdır.
 */
export const CARD_FETCH: CardFetchOptions = { maxBytes: 256 * 1024, timeoutMs: 10_000 };

export const ZERO_HASH = new Uint8Array(32);

export function agentIdProblem(agentId: string): string | null {
  if (agentId.length === 0) return 'Choose an agent ID.';
  if (new TextEncoder().encode(agentId).length > 32) return 'The agent ID is at most 32 characters.';
  if (!AGENT_ID_PATTERN.test(agentId)) return 'Use only letters, digits, "_" and "-".';
  return null;
}

/** Boş URI kartsız kayıttır (sıfır hash). Dolu URI https olmalı ve 200 baytı aşmamalı. */
export function cardUriProblem(uri: string): string | null {
  if (uri === '') return null;
  if (new TextEncoder().encode(uri).length > MAX_CARD_URI_BYTES)
    return `The card URI is at most ${MAX_CARD_URI_BYTES} bytes.`;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'The card URI is not a URL.';
  }
  if (url.protocol !== 'https:') return 'The card must be served over https.';
  return null;
}

/** CAIP-2 zincir referansı: genesis hash'inin ilk 32 karakteri (profil §3.3). */
export const chainRefOf = (genesisHash: string) => genesisHash.slice(0, 32);

export interface AgentIdentity {
  agentRecord: PublicKey;
  did: string;
  /** Kartın `registrations` listesinde bu kaydı gösteren girdi (profil §3.5). */
  registration: AgentRegistration;
}

/** Tx'ten önce hesaplanan kayıt adresi, DID ve kart girdisi. */
export function agentIdentity(input: {
  genesisHash: string;
  registry: PublicKey;
  creator: PublicKey;
  agentId: string;
}): AgentIdentity {
  const chainRef = chainRefOf(input.genesisHash);
  const agentRecord = agentRecordAddress(input.registry, input.creator, input.agentId);
  return {
    agentRecord,
    did: squareIdentity.formatDidAip({ chainRef, registry: input.registry, agentRecord }),
    registration: {
      agentRegistry: `solana:${chainRef}:${input.registry.toBase58()}`,
      agentId: agentRecord.toBase58(),
    },
  };
}

export type CardCheck =
  { state: 'verified'; card: AgentCard; hash: Uint8Array } | { state: 'invalid'; problems: string[] };

/** Kartın bu kaydı listelediği denetlenir; listelemiyorsa kart başka bir kimliği anlatıyordur. */
export function checkCard(card: AgentCard, bytes: Uint8Array, registration: AgentRegistration): CardCheck {
  const listed = card.registrations.some(
    (entry) => entry.agentRegistry === registration.agentRegistry && entry.agentId === registration.agentId,
  );
  if (!listed) {
    return {
      state: 'invalid',
      problems: ["The card's registrations do not list this agent. Add the entry below and publish the card again."],
    };
  }
  return { state: 'verified', card, hash: sha256(bytes) };
}

/** Kartı indirir, Square kart şemasıyla doğrular ve bu kayda ait olduğunu denetler. */
export async function fetchAndCheckCard(uri: string, registration: AgentRegistration): Promise<CardCheck> {
  let fetched: Awaited<ReturnType<typeof squareIdentity.fetchAgentCard>>;
  try {
    fetched = await squareIdentity.fetchAgentCard(uri, CARD_FETCH);
  } catch (error) {
    return { state: 'invalid', problems: describeCardError(error) };
  }
  return checkCard(fetched.card, fetched.bytes, registration);
}

export type HostedCardDraft =
  | {
      state: 'ready';
      card: AgentCard;
      /** API'nin saklayacağı baytların (şemadan geçmiş kartın RFC 8785 kanonik JSON'u) SHA-256'sı. */
      hash: Uint8Array;
      /** Girdi şemanın okuduğu biçimden farklı: şemada olmayan alanlar çıkar, eksik varsayılanlar dolar. */
      normalized: boolean;
    }
  | { state: 'invalid'; problems: string[] };

/**
 * Square API'de barındırılacak kart: JSON, Square kart şeması ve bu kaydın girdisi. API kartı şemadan
 * geçirip kanonik JSON'unu saklar; hash aynı baytlardan burada hesaplanır.
 */
export function checkHostedCard(text: string, registration: AgentRegistration): HostedCardDraft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'invalid', problems: ['The card is not valid JSON.'] };
  }
  const parsed = AgentCardSchema.safeParse(value);
  if (!parsed.success) return { state: 'invalid', problems: describeCardError(parsed.error) };
  const canonical = specHashing.canonicalizeSpec(parsed.data);
  const checked = checkCard(parsed.data, new TextEncoder().encode(canonical), registration);
  if (checked.state === 'invalid') return checked;
  return { state: 'ready', card: parsed.data, hash: checked.hash, normalized: canonicalOf(value) !== canonical };
}

/** Girdinin kendi kanonik biçimi; kanonikleştirilemiyorsa null (şemadan geçmiş biçimden farklı sayılır). */
function canonicalOf(value: unknown): string | null {
  try {
    return specHashing.canonicalizeSpec(value);
  } catch {
    return null;
  }
}

/** API'nin barındırdığı kartın hash'i tarayıcıdakiyle aynı mı? Değilse kayda o hash yazılmaz. */
export function hostingProblem(hosting: AgentCardHosting, hash: Uint8Array): string | null {
  return hosting.agentCardHash === hex(hash)
    ? cardUriProblem(hosting.agentCardUri)
    : `The Square API hashed the card as ${hosting.agentCardHash}, not ${hex(hash)}; that hash is not registered.`;
}

/** Kart hatasının okunur açıklaması. */
export function describeCardError(error: unknown): string[] {
  // Şema hatası (zod); örnek, paketlerin zod kopyasından bağımsız olsun diye yapısından tanınır.
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues)) {
    return (issues as { path: PropertyKey[]; message: string }[]).slice(0, 5).map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
  }
  if (error instanceof SyntaxError) return ['The card is not valid UTF-8 JSON.'];
  // fetchCardBytes ağ hatasını, zaman aşımını, yönlendirmeyi, 2xx dışı yanıtı ve boyut aşımını ayırt etmez.
  return [
    'The card could not be downloaded. It must be served over https without redirects, allow cross-origin ' +
      `requests from this site, answer within ${CARD_FETCH.timeoutMs / 1000} s and stay under ` +
      `${CARD_FETCH.maxBytes / 1024} KiB.`,
  ];
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export interface RegisterAgentInput {
  registry: PublicKey;
  payer: PublicKey;
  owner: PublicKey;
  agentId: string;
  agentCardUri: string;
  agentCardHash: Uint8Array;
  wallet: PublicKey;
}

/** `register_agent` (registry IDL); ücreti ve rent'i `payer` öder, `owner` imzalar. Ağa gitmez. */
export function registerAgentInstruction(
  connection: Connection,
  input: RegisterAgentInput,
): Promise<TransactionInstruction> {
  const program = new Program<SquareRegistryContract>(
    { ...SQUARE_IDLS.registry, address: input.registry.toBase58() },
    { connection },
  );
  return program.methods
    .registerAgent(input.agentId, input.agentCardUri, Array.from(input.agentCardHash), input.wallet)
    .accountsStrict({
      payer: input.payer,
      owner: input.owner,
      agentRecord: agentRecordAddress(input.registry, input.owner, input.agentId),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** İmzasız v0 tx; blockhash bağlantıdan. */
export async function buildRegisterAgentTx(
  connection: Connection,
  input: RegisterAgentInput,
): Promise<VersionedTransaction> {
  const [instruction, { blockhash }] = await Promise.all([
    registerAgentInstruction(connection, input),
    connection.getLatestBlockhash('confirmed'),
  ]);
  const message = new TransactionMessage({
    payerKey: input.payer,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** Registry hata kodunun IDL'deki açıklaması; registry hatası değilse null. */
export const registryErrorMessage = (error: unknown): string | null => programErrorMessage(SQUARE_IDLS.registry, error);
