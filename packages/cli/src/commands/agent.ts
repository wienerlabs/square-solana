// Adım 2: agent kaydı ve did:aip çözümü (BE-09); adım 3: screening kaydı (screener servisinin anahtarı).
import { sha256 } from '@noble/hashes/sha2';
import { SystemProgram } from '@solana/web3.js';
import { squareIdentity, type CardFetchOptions } from '@squaresdk/solana-identity';
import { withComputeProfile } from '@squaresdk/solana-sdk';
import type { Context } from '../context.js';
import { address, bytes32, CliError, readBytes, required } from '../io.js';
import { str, type Command } from './types.js';

/** Agent card indirme sınırları (web uygulamasıyla aynı). */
export const CARD_FETCH: CardFetchOptions = { maxBytes: 256 * 1024, timeoutMs: 10_000 };
/** Çözüm başına gidiş-dönüş doğrulanan çapraz kayıt sayısı (v2 §8). */
export const CROSS_REGISTRATION_LIMIT = 3;
/** CAIP-2 Solana zincir referansı: genesis hash'in ilk 32 karakteri. */
export const chainRef = async (ctx: Context) => (await ctx.connection.getGenesisHash()).slice(0, 32);

const ZERO = new Uint8Array(32);

const register: Command = {
  group: 'agent',
  action: 'register',
  summary: 'adım 2: agent kaydı (imzacı kaydın sahibi)',
  usage: [
    ['--id <agent_id>', '1–32 karakter, [A-Za-z0-9_-]'],
    ['--card-uri <uri>', 'agent card adresi; verilmezse kart yok'],
    ['--card-file <yol>', 'kartın baytları; hash SHA-256 (did:aip v2 §4.2)'],
    ['--wallet <adres>', 'ödemeleri alan cüzdan; verilmezse imzacı'],
  ],
  options: {
    id: { type: 'string' },
    'card-uri': { type: 'string' },
    'card-file': { type: 'string' },
    wallet: { type: 'string' },
  },
  async run(ctx, values) {
    const agentId = required(str(values, 'id'), 'id');
    const uri = str(values, 'card-uri') ?? '';
    const file = str(values, 'card-file');
    if (uri === '' && file) throw new CliError('--card-file yalnızca --card-uri ile verilir');
    if (uri !== '' && !file) throw new CliError("--card-uri ile kartın hash'i için --card-file gerekli");
    const cardHash = file ? sha256(readBytes(file, 'agent card')) : ZERO;
    const wallet = str(values, 'wallet') ? address(str(values, 'wallet'), 'wallet') : ctx.signer.publicKey;
    let agentRecord = ctx.client.pda.agentRecord(ctx.signer.publicKey, agentId)[0];
    const { signature } = await ctx.send('register_agent', async () => {
      const built = await ctx.client.flow.registerAgent(
        { owner: ctx.signer.publicKey, agentId, agentCardUri: uri, agentCardHash: cardHash, wallet },
        ctx.options(),
      );
      agentRecord = built.agentRecord;
      return built;
    });
    const did = squareIdentity.formatDidAip({
      chainRef: await chainRef(ctx),
      registry: ctx.client.programIds.registry,
      agentRecord,
    });
    return { signature, agentRecord, did, wallet, agentCardHash: cardHash };
  },
};

const resolve: Command = {
  group: 'agent',
  action: 'resolve',
  summary: 'did:aip çözümü: DID belgesi ve kartın hash doğrulaması (BE-09)',
  usage: [['<did>', 'did:aip:solana:<zincir>:<registry>:<kayıt>']],
  options: {},
  positional: 'did',
  async run(ctx, _values, did) {
    if (!did) throw new CliError('çözülecek DID gerekli: agent resolve <did>');
    const result = await squareIdentity.resolveDid(did, {
      connections: { [await chainRef(ctx)]: ctx.connection },
      commitment: ctx.config.commitment,
      card: CARD_FETCH,
      crossRegistrationLimit: CROSS_REGISTRATION_LIMIT,
    });
    const error = result.didResolutionMetadata.error;
    if (error) throw new CliError(`${did} çözülemedi: ${error}`);
    return {
      did,
      didDocument: result.didDocument,
      didDocumentMetadata: result.didDocumentMetadata,
      warnings: result.didResolutionMetadata.warnings ?? [],
    };
  },
};

const STATUSES = ['clear', 'flagged'] as const;

const screening: Command = {
  group: 'screening',
  action: 'record',
  summary: "adım 3: sanctions screening kaydı (imzacı registry config'indeki screener authority)",
  usage: [
    ['--wallet <adres>', 'taranan cüzdan'],
    ['--status', '<clear|flagged>'],
    ['--source-hash <hex>', "kanıt belgesinin SHA-256'sı (ADR 0020)"],
  ],
  options: { wallet: { type: 'string' }, status: { type: 'string' }, 'source-hash': { type: 'string' } },
  async run(ctx, values) {
    const wallet = address(str(values, 'wallet'), 'wallet');
    const status = required(str(values, 'status'), 'status');
    if (!(STATUSES as readonly string[]).includes(status)) throw new CliError(`--status ${STATUSES.join(' | ')}`);
    const sourceHash = bytes32(str(values, 'source-hash'), 'source-hash');
    const { pda } = ctx.client;
    const { signature } = await ctx.send('record_screening', async () =>
      ctx.client.buildTx(
        [
          await ctx.client.registry.program.methods
            .recordScreening(wallet, { [status]: {} } as never, Array.from(sourceHash))
            .accountsStrict({
              payer: ctx.feePayer.publicKey,
              screenerAuthority: ctx.signer.publicKey,
              config: pda.registryConfig()[0],
              screeningRecord: pda.screeningRecord(wallet)[0],
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
        ],
        withComputeProfile(ctx.options(), 'recordScreening'),
      ),
    );
    const record = await ctx.client.registry.fetch('screeningRecord', pda.screeningRecord(wallet)[0]);
    return {
      signature,
      screeningRecord: pda.screeningRecord(wallet)[0],
      wallet,
      status,
      expiresAt: record ? record.expiresAt.toString() : null,
    };
  },
};

export const AGENT_COMMANDS: readonly Command[] = [register, resolve, screening];
