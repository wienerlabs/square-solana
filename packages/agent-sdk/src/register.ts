// Kayıt yardımcısı (Arc adım 2): kartın adresi ve hash'i `register_agent`'a yazılır; kayıt varsa ve kart,
// adres ya da cüzdan değiştiyse `update_agent`. Kart ya agent'ın kendi well-known yolundadır (`self`) ya da
// Square API'sinde barındırılır (`api`, `putAgentCard`); iki durumda da hash kartın RFC 8785 baytlarınındır.
import { PublicKey } from '@solana/web3.js';
import type { BuildOptions, SquareApi, SquareClient, WalletLike } from '@squaresdk/solana-sdk';
import type { AgentCard } from '@squaresdk/solana-types';
import { toWallet, type TxSender } from './chain.js';
import type { AgentLogger, RegisterOptions, RegistrationResult, TxOptions } from './types.js';

/** Registry `MAX_AGENT_CARD_URI_LEN`. */
export const AGENT_CARD_URI_MAX_BYTES = 200;

export interface RegisterDeps {
  client: SquareClient;
  sender: TxSender;
  wallet: WalletLike;
  owner: PublicKey;
  agentId: string;
  agentRecord: PublicKey;
  card: AgentCard;
  cardHash: string;
  cardUrl: string;
  api: SquareApi | null;
  tx: TxOptions;
  logger?: AgentLogger;
}

/** Kapanmış işin durumları; geri kalanların ön-ispatı ve ödemesi agent cüzdanına bağlıdır. */
const SETTLED = new Set(['released', 'refunded', 'cancelled']);

/** Kaydın kapanmamış policy'li işleri (`Job.agent_record`, discriminator'dan sonraki ikinci alan). */
async function openPolicyJobs(client: SquareClient, agentRecord: PublicKey): Promise<PublicKey[]> {
  const jobs = await client.escrow.program.account.job.all([
    { memcmp: { offset: 8 + 32, bytes: agentRecord.toBase58() } },
  ]);
  return jobs
    .filter(({ account }) => account.policy !== null && !SETTLED.has(Object.keys(account.status)[0] ?? ''))
    .map(({ publicKey }) => new PublicKey(publicKey));
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('hex');

async function hosting(deps: RegisterDeps, mode: 'self' | 'api'): Promise<{ uri: string; hash: string }> {
  if (mode === 'self') return { uri: deps.cardUrl, hash: deps.cardHash };
  if (!deps.api) throw new Error("register: hosting 'api' için createAgent'a api verilmeli");
  const envelope = await deps.api.putAgentCard(deps.agentRecord.toBase58(), deps.card, { agentId: deps.agentId });
  if (!envelope.success || !envelope.data) {
    throw new Error(
      `register: kart barındırılamadı: ${envelope.error?.code ?? 'bilinmiyor'} ${envelope.error?.message ?? ''}`,
    );
  }
  const { agentCardUri, agentCardHash } = envelope.data;
  // API kartı aynı kanonikleştirmeyle saklar; farklı hash, sunulan kartla zincirdeki hash'in ayrışması olurdu.
  if (agentCardHash !== deps.cardHash) {
    throw new Error(`register: API'nin kart hash'i (${agentCardHash}) agent'ınkiyle (${deps.cardHash}) aynı değil`);
  }
  return { uri: agentCardUri, hash: agentCardHash };
}

export async function registerAgent(deps: RegisterDeps, options: RegisterOptions = {}): Promise<RegistrationResult> {
  const { client, sender, wallet } = deps;
  const ownerWallet = options.owner ? toWallet(options.owner) : null;
  if (ownerWallet && !ownerWallet.publicKey.equals(deps.owner)) {
    throw new Error(
      `register: owner imzacısı ${ownerWallet.publicKey.toBase58()}, kaydın sahibi ${deps.owner.toBase58()}`,
    );
  }
  if (!ownerWallet && !deps.owner.equals(wallet.publicKey)) {
    throw new Error('register: kaydın sahibi signer değil; options.owner ile sahibin imzacısı verilmeli');
  }
  const { uri, hash } = await hosting(deps, options.hosting ?? 'self');
  if (Buffer.byteLength(uri, 'utf8') > AGENT_CARD_URI_MAX_BYTES) {
    throw new Error(`register: kart adresi ${AGENT_CARD_URI_MAX_BYTES} baytı aşıyor: ${uri}`);
  }
  const signers = ownerWallet ? [wallet, ownerWallet] : [wallet];
  const buildOptions: BuildOptions = {
    feePayer: wallet.publicKey,
    ...(deps.tx.computeUnitPrice !== undefined ? { computeUnitPrice: deps.tx.computeUnitPrice } : {}),
    ...(deps.tx.addressLookupTables ? { addressLookupTables: deps.tx.addressLookupTables } : {}),
  };
  const result = (
    status: RegistrationResult['status'],
    signature: string | null,
    open: PublicKey[] = [],
  ): RegistrationResult => ({
    status,
    agentRecord: deps.agentRecord,
    agentCardUri: uri,
    agentCardHash: hash,
    signature,
    openPolicyJobs: open,
  });

  const existing = await client.registry.fetch('agentRecord', deps.agentRecord);
  if (!existing) {
    const built = await client.flow.registerAgent(
      {
        owner: deps.owner,
        agentId: deps.agentId,
        agentCardUri: uri,
        agentCardHash: Buffer.from(hash, 'hex'),
        wallet: wallet.publicKey,
      },
      buildOptions,
    );
    return result('registered', await sender.send('register_agent', built, signers));
  }
  if (!existing.owner.equals(deps.owner)) {
    throw new Error(`register: kayıt başka bir sahibe ait: ${existing.owner.toBase58()}`);
  }
  if (
    existing.agentCardUri === uri &&
    hex(existing.agentCardHash) === hash &&
    existing.wallet.equals(wallet.publicKey)
  ) {
    return result('unchanged', null);
  }
  // Cüzdan değişince kapanmamış policy'li işler eski cüzdanda kalır; ön-ispatları o cüzdan içindir (ADR 0028).
  const open = existing.wallet.equals(wallet.publicKey) ? [] : await openPolicyJobs(client, deps.agentRecord);
  const ix = await client.registry.instructions.updateAgent(
    [uri, Array.from(Buffer.from(hash, 'hex')), wallet.publicKey],
    { owner: deps.owner, agentRecord: deps.agentRecord },
  );
  const built = await client.buildTx([ix], buildOptions);
  const signature = await sender.send('update_agent', built, signers);
  if (open.length > 0) {
    deps.logger?.info(
      `register: agent cüzdanı değişti; ${open.length} kapanmamış policy'li iş eski cüzdanda kalır ` +
        `(${open.map((job) => job.toBase58()).join(', ')}). sync_agent_wallet ile taşınan işte kabulden önce kurum ` +
        'ön-ispatı yeni cüzdan için yeniden bağlamalı; kabulden sonra ön-ispatın güvencesi yeni cüzdanı kapsamaz (ADR 0028)',
    );
  }
  return result('updated', signature, open);
}
