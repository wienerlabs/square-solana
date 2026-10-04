// did:aip çözümü: Solana profili §6.1, v1 §6.1 (Solana profili §9.2), çapraz kayıtlar v2 §8.
// Çözücü asla fırlatmaz; her başarısızlık `didResolutionMetadata.error`'dadır.
import { Program, type Idl } from '@anchor-lang/core';
import { PublicKey, type Connection } from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { classifyCard, fetchCardBytes, uriScheme, verifyAgentCardHash } from './card.js';
import { AIP_V1_PROGRAM_ID, CHAIN_REFS, DID_CONTENT_TYPE } from './constants.js';
import { didFromRegistration, parseDidAip } from './did.js';
import { buildDidDocument, buildV1Document } from './document.js';
import type {
  AgentRecordView,
  DidDocumentMetadata,
  DidResolutionError,
  DidResolutionResult,
  ResolutionWarning,
  ResolvedCard,
  ResolverOptions,
} from './types.js';
import { decodeV1AgentRecord } from './v1.js';

type Solana = Extract<ReturnType<typeof parseDidAip>, { namespace: 'solana' }>;

const failure = (error: DidResolutionError): DidResolutionResult => ({
  didDocument: null,
  didDocumentMetadata: {},
  didResolutionMetadata: { error },
});

const normalize = (name: string) => name.replace(/_/g, '').toLowerCase();
const registryIdl = SQUARE_IDLS.registry as unknown as Idl;

/** `AGENT_SEED` (registry IDL sabiti); v1 programı da aynı seed'i kullanır (Solana profili §3.4). */
const AGENT_SEED = Uint8Array.from(
  JSON.parse((registryIdl.constants ?? []).find((c) => normalize(c.name) === 'agentseed')!.value) as number[],
);

/** Anchor'ın `AgentRecord` discriminator'ı; v1 ve Square registry'si paylaşır (§9.2). */
const AGENT_RECORD_DISCRIMINATOR = Uint8Array.from(
  (registryIdl.accounts ?? []).find((a) => normalize(a.name) === 'agentrecord')!.discriminator,
);

const startsWith = (data: Uint8Array, prefix: Uint8Array) => prefix.every((byte, i) => data[i] === byte);
const isoSeconds = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Genesis hash'i chain-ref ile başlayan bağlantılar (Solana profili §6.1 adım 3, §10.4). */
const verifiedGenesis = new WeakMap<Connection, string>();

async function checkedConnection(chainRef: string, options: ResolverOptions): Promise<Connection | DidResolutionError> {
  const connection = options.connections[chainRef];
  if (!connection) return 'unsupportedChain';
  if (verifiedGenesis.get(connection) === chainRef) return connection;
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch {
    return 'networkError';
  }
  if (!genesis.startsWith(chainRef)) return 'unsupportedChain';
  verifiedGenesis.set(connection, chainRef);
  return connection;
}

interface ReadRecord {
  record: AgentRecordView;
  slot: number;
}

/** §6.1 adım 5–8: kaydı okur, sahibini, discriminator'ını ve adresini denetler. */
async function readRecord(
  parsed: Solana,
  connection: Connection,
  options: ResolverOptions,
): Promise<ReadRecord | DidResolutionError> {
  const registry = new PublicKey(parsed.registry);
  const address = new PublicKey(parsed.agentRecord);
  let response: Awaited<ReturnType<Connection['getAccountInfoAndContext']>>;
  try {
    response = await connection.getAccountInfoAndContext(address, { commitment: options.commitment });
  } catch {
    return 'networkError';
  }
  const account = response.value;
  if (!account) return 'notFound';
  if (!account.owner.equals(registry) || !startsWith(account.data, AGENT_RECORD_DISCRIMINATOR)) return 'notFound';
  let decoded: {
    creator: PublicKey;
    agentId: string;
    bump: number;
    owner: PublicKey;
    wallet: PublicKey;
    agentCardUri: string;
    agentCardHash: number[];
    status: Record<string, unknown>;
    registeredAt: { toNumber(): number };
    updatedAt: { toNumber(): number };
  };
  try {
    const program = new Program({ ...registryIdl, address: parsed.registry }, { connection });
    decoded = program.coder.accounts.decode('agentRecord', account.data);
  } catch {
    return 'internalError';
  }
  try {
    const derived = PublicKey.createProgramAddressSync(
      [AGENT_SEED, decoded.creator.toBytes(), new TextEncoder().encode(decoded.agentId), Uint8Array.of(decoded.bump)],
      registry,
    );
    if (!derived.equals(address)) return 'notFound';
  } catch {
    return 'notFound';
  }
  const status = Object.keys(decoded.status)[0] as AgentRecordView['status'];
  return {
    slot: response.context.slot,
    record: {
      creator: decoded.creator,
      agentId: decoded.agentId,
      bump: decoded.bump,
      owner: decoded.owner,
      wallet: decoded.wallet,
      agentCardUri: decoded.agentCardUri,
      agentCardHash: Uint8Array.from(decoded.agentCardHash),
      status,
      registeredAt: decoded.registeredAt.toNumber(),
      updatedAt: decoded.updatedAt.toNumber(),
    },
  };
}

function registryRejected(registry: string, options: ResolverOptions): boolean {
  if (registry === AIP_V1_PROGRAM_ID) return true;
  return options.registryAllowlist !== undefined && !options.registryAllowlist.includes(registry);
}

/** Karşı tarafın doğrulanmış kartı bu ajanı geri listeliyor mu (v2 §8; karşı tarafın iddiaları izlenmez). */
async function listsBack(claim: string, self: Solana, options: ResolverOptions): Promise<boolean> {
  let counterpart: ReturnType<typeof parseDidAip>;
  try {
    counterpart = parseDidAip(claim);
  } catch {
    return false;
  }
  if (counterpart.version !== 2 || counterpart.namespace !== 'solana') return false;
  if (registryRejected(counterpart.registry, options)) return false;
  const connection = await checkedConnection(counterpart.chainRef, options);
  if (typeof connection === 'string') return false;
  const read = await readRecord(counterpart, connection, options);
  if (typeof read === 'string' || read.record.agentCardUri === '') return false;
  const bytes = await fetchCardBytes(read.record.agentCardUri, options.card);
  if (!bytes || !verifyAgentCardHash(bytes, read.record.agentCardHash)) return false;
  try {
    const card: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const registrations = (card as { registrations?: unknown }).registrations;
    return (
      Array.isArray(registrations) &&
      registrations.some(
        (r: { agentRegistry?: unknown; agentId?: unknown }) =>
          r?.agentRegistry === self.agentRegistry && String(r?.agentId) === self.agentRecord,
      )
    );
  } catch {
    return false;
  }
}

async function crossRegistrations(
  self: Solana,
  card: ResolvedCard,
  malformed: number,
  options: ResolverOptions,
): Promise<{ result?: DidDocumentMetadata['crossRegistrations']; warnings: ResolutionWarning[] }> {
  const mapped = (card.registrations ?? []).map((r) => didFromRegistration(r.agentRegistry, r.agentId));
  const unmappable = mapped.filter((did) => did === null).length + malformed;
  const claims = [...new Set(mapped.filter((did): did is string => did !== null && did !== self.did))];
  const warnings: ResolutionWarning[] = [];
  if (unmappable > 0) {
    warnings.push({
      code: 'crossRegistrationMalformed',
      message: `${unmappable} registration(s) do not map to a did:aip v2 DID`,
    });
  }
  if (claims.length === 0) return { warnings };
  const checked = claims.slice(0, options.crossRegistrationLimit);
  if (claims.length > checked.length) {
    warnings.push({
      code: 'crossRegistrationLimit',
      message: `${claims.length - checked.length} cross-registration(s) beyond the limit of ${options.crossRegistrationLimit} were not checked`,
    });
  }
  const outcomes = await Promise.all(checked.map((claim) => listsBack(claim, self, options)));
  return {
    result: {
      verified: checked.filter((_, i) => outcomes[i]),
      unverified: [...checked.filter((_, i) => !outcomes[i]), ...claims.slice(checked.length)],
    },
    warnings,
  };
}

async function resolveSolana(parsed: Solana, options: ResolverOptions): Promise<DidResolutionResult> {
  if (!options.connections[parsed.chainRef]) return failure('unsupportedChain');
  if (registryRejected(parsed.registry, options)) return failure('registryNotAllowed');
  const connection = await checkedConnection(parsed.chainRef, options);
  if (typeof connection === 'string') return failure(connection);
  const read = await readRecord(parsed, connection, options);
  if (typeof read === 'string') return failure(read);
  const { record, slot } = read;
  const caip10 = (key: PublicKey) => `solana:${parsed.chainRef}:${key.toBase58()}`;
  const metadata: DidDocumentMetadata = {
    versionId: String(slot),
    created: isoSeconds(record.registeredAt),
    updated: isoSeconds(record.updatedAt),
    agentRegistry: parsed.agentRegistry,
    owner: caip10(record.owner),
    agentWallet: caip10(record.wallet),
    agentStatus: record.status,
  };
  const context = { did: parsed.did, chainRef: parsed.chainRef };
  if (record.status === 'deregistered') {
    return {
      didDocument: buildDidDocument(record, null, context),
      didDocumentMetadata: { ...metadata, deactivated: true, deactivation: 'deregistered' },
      didResolutionMetadata: { contentType: DID_CONTENT_TYPE },
    };
  }
  const outcome = await classifyCard(record.agentCardUri, record.agentCardHash, options.card);
  const verifiedCard = outcome.status === 'verified' ? outcome.card : null;
  const cross = verifiedCard
    ? await crossRegistrations(parsed, verifiedCard, outcome.malformedRegistrations, options)
    : { warnings: [] };
  const deactivation =
    record.status === 'inactive' ? 'inactive' : verifiedCard?.active === false ? 'agentCard' : undefined;
  const scheme = record.agentCardUri === '' ? null : uriScheme(record.agentCardUri);
  const warnings = [...(outcome.warning ? [outcome.warning] : []), ...cross.warnings];
  return {
    didDocument: buildDidDocument(record, verifiedCard, context),
    didDocumentMetadata: {
      ...metadata,
      ...(scheme && { agentCardUriScheme: scheme }),
      agentCard: outcome.status,
      ...(deactivation && { deactivated: true as const, deactivation }),
      ...(cross.result && { crossRegistrations: cross.result }),
    },
    didResolutionMetadata: { contentType: DID_CONTENT_TYPE, ...(warnings.length > 0 && { warnings }) },
  };
}

/** v1 çözümü (v1 §6.1): devnet, v1 programı, `["agent", owner, agent_id]`. */
async function resolveV1(
  did: string,
  owner: string,
  agentId: string,
  options: ResolverOptions,
): Promise<DidResolutionResult> {
  const connection = await checkedConnection(CHAIN_REFS.devnet, options);
  if (typeof connection === 'string') return failure(connection);
  const program = new PublicKey(AIP_V1_PROGRAM_ID);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [AGENT_SEED, new PublicKey(owner).toBytes(), new TextEncoder().encode(agentId)],
    program,
  );
  let response: Awaited<ReturnType<Connection['getAccountInfoAndContext']>>;
  try {
    response = await connection.getAccountInfoAndContext(pda, { commitment: options.commitment });
  } catch {
    return failure('networkError');
  }
  const account = response.value;
  if (!account || !account.owner.equals(program) || !startsWith(account.data, AGENT_RECORD_DISCRIMINATOR)) {
    return failure('notFound');
  }
  let record: ReturnType<typeof decodeV1AgentRecord>;
  try {
    record = decodeV1AgentRecord(account.data);
  } catch {
    return failure('internalError');
  }
  return {
    didDocument: buildV1Document(did, record.walletAddress, record.endpoint),
    didDocumentMetadata: {
      network: 'solana:devnet',
      pda: pda.toBase58(),
      bump,
      versionId: String(response.context.slot),
      deprecated: true,
    },
    didResolutionMetadata: { contentType: DID_CONTENT_TYPE },
  };
}

export async function resolveDid(did: string, options: ResolverOptions): Promise<DidResolutionResult> {
  let parsed: ReturnType<typeof parseDidAip>;
  try {
    parsed = parseDidAip(did);
  } catch {
    return failure('invalidDid');
  }
  try {
    if (parsed.version === 1) return await resolveV1(parsed.did, parsed.owner, parsed.agentId, options);
    // EVM (eip155) v2 DID'leri bu çözücünün kapsamında değil.
    if (parsed.namespace === 'eip155') return failure('unsupportedChain');
    return await resolveSolana(parsed, options);
  } catch {
    // Spesifikasyon gereği fırlatılmaz (§6.1); beklenmeyen hata internalError olarak döner.
    return failure('internalError');
  }
}
