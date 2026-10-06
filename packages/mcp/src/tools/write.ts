// Yazma araçları (imza akışıyla, signing.ts): job açma ve fonlama (kurum), kabul ve teslim (agent), istemcide
// imzalanmış tx'in gönderilmesi. Tx'ler SDK'nın 8 adım akışıyla kurulur (`client.flow`); rol imzacısı zincirdeki
// job'dan okunur, araç argümanından alınmaz.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';
import { createApiClient, type SquareClient } from '@squaresdk/solana-sdk';
import { z } from 'zod';
import type { ChainReader } from '../chain.js';
import type { SquareMcpConfig } from '../config.js';
import { guarded } from '../result.js';
import type { Signing } from '../signing.js';
import { toBaseUnits } from '../units.js';

const Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'base58 Solana adresi');
const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, '32 bayt küçük harf hex');
const SIGNING_NOTE =
  'Requires the signature of the role wallet: with SQUARE_MCP_KEYPAIR set to that wallet the server signs and ' +
  'sends; otherwise it returns the unsigned transaction to sign.';

export function registerWriteTools(
  server: McpServer,
  deps: {
    client: SquareClient;
    connection: Connection;
    reader: ChainReader;
    signing: Signing;
    config: SquareMcpConfig;
  },
): void {
  const { client, connection, reader, signing, config } = deps;

  async function jobAccount(job: string) {
    const account = await reader.job(new PublicKey(job));
    if (!account) throw new Error(`job bulunamadı: ${job}`);
    return account as Record<string, unknown> & {
      institution: PublicKey;
      agentWallet: PublicKey;
      mint: PublicKey;
      status: Record<string, unknown>;
    };
  }

  server.registerTool(
    'square_create_job',
    {
      title: 'Open a job',
      description: [
        'Open a Square job (institution side): binds the job to an agent record, hashes the spec (RFC 8785) on',
        'chain and fixes the amount, deadline and challenge window. The escrow is funded separately with',
        `square_fund_job. ${SIGNING_NOTE}`,
      ].join(' '),
      inputSchema: {
        agentRecord: Address.describe('Agent record to hire.'),
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(4000),
        amount: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe('Amount in USDC, e.g. "25".'),
        deadline: z.iso.datetime().describe('Delivery deadline, ISO 8601 (UTC).'),
        challengePeriodSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Challenge window after delivery; default the escrow config minimum.'),
        policy: Address.optional().describe("Institution's spending policy; release then needs a compliance proof."),
        institution: Address.optional().describe('Institution key; required when the server has no keypair.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const institution = config.signer?.publicKey ?? (args.institution ? new PublicKey(args.institution) : null);
      if (!institution) throw new Error('institution verilmeli (sunucunun anahtarı yok)');
      if (args.institution && !institution.equals(new PublicKey(args.institution))) {
        throw new Error(`institution ${args.institution}, sunucunun anahtarı ${institution.toBase58()}`);
      }
      const { decimals, challengePeriod } = await reader.settlement();
      const period =
        args.challengePeriodSeconds === undefined ? challengePeriod.min : BigInt(args.challengePeriodSeconds);
      if (period < challengePeriod.min || period > challengePeriod.max) {
        throw new Error(`challenge penceresi ${challengePeriod.min}–${challengePeriod.max} saniye olmalı`);
      }
      const deadline = Math.floor(Date.parse(args.deadline) / 1000);
      if (deadline <= Math.floor(Date.now() / 1000)) throw new Error('deadline gelecekte olmalı');
      const built = await client.flow.createJob(
        {
          institution,
          agentRecord: new PublicKey(args.agentRecord),
          ...(args.policy && { policy: new PublicKey(args.policy) }),
          spec: { title: args.title, description: args.description },
          amount: toBaseUnits(args.amount, decimals),
          deadline,
          challengePeriod: period,
        },
        signing.options(institution),
      );
      return {
        job: built.job.toBase58(),
        specHash: Buffer.from(built.specHash).toString('hex'),
        ...(await signing.complete(built, institution)),
      };
    }),
  );

  server.registerTool(
    'square_fund_job',
    {
      title: 'Fund a job',
      description: [
        "Lock the job amount in its escrow vault from the institution's USDC account (institution side). Both",
        `the institution and the agent wallet need a clear sanctions screening record. ${SIGNING_NOTE}`,
      ].join(' '),
      inputSchema: { job: Address.describe('Job account address (status open).') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(async ({ job }) => {
      const account = await jobAccount(job);
      const mint = await connection.getAccountInfo(account.mint, 'confirmed');
      if (!mint) throw new Error(`mint bulunamadı: ${account.mint.toBase58()}`);
      const institutionTokenAccount = getAssociatedTokenAddressSync(
        account.mint,
        account.institution,
        true,
        mint.owner,
      );
      const built = await client.flow.fundJob(
        { institution: account.institution, job: new PublicKey(job), institutionTokenAccount },
        signing.options(account.institution),
      );
      return { job, ...(await signing.complete(built, account.institution)) };
    }),
  );

  server.registerTool(
    'square_accept_job',
    {
      title: 'Accept a job',
      description: `Accept a funded job bound to your agent record (agent side, signed by the agent wallet). ${SIGNING_NOTE}`,
      inputSchema: { job: Address.describe('Job account address (status funded).') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(async ({ job }) => {
      const account = await jobAccount(job);
      const built = await client.flow.acceptJob(
        { agent: account.agentWallet, job: new PublicKey(job) },
        signing.options(account.agentWallet),
      );
      return { job, ...(await signing.complete(built, account.agentWallet)) };
    }),
  );

  server.registerTool(
    'square_submit_work',
    {
      title: 'Deliver work',
      description: [
        'Deliver the work for an accepted job (agent side): records the SHA-256 of the delivery and its URI on chain',
        'and starts the challenge window. Give content to upload it to the Square API (needs SQUARE_API_URL and',
        `SQUARE_API_KEY), or deliveryUri and workHash for content hosted elsewhere. ${SIGNING_NOTE}`,
      ].join(' '),
      inputSchema: {
        job: Address.describe('Job account address (status accepted).'),
        content: z.string().min(1).optional().describe('Delivery content to upload.'),
        contentType: z.string().min(1).max(120).optional().describe('MIME type of content; default text/plain.'),
        deliveryUri: z.string().min(1).max(128).optional().describe('Where the delivery is hosted.'),
        workHash: Hex32.optional().describe('SHA-256 of the delivery bytes, hex.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args) => {
      const account = await jobAccount(args.job);
      let delivery: { workHash: string; deliveryUri: string };
      if (args.content !== undefined) {
        if (args.deliveryUri || args.workHash) throw new Error('content ya da deliveryUri + workHash verilir');
        if (!config.api) throw new Error('içerik yüklemek için SQUARE_API_URL ve SQUARE_API_KEY gerekli');
        const api = createApiClient({ baseUrl: config.api.url, auth: { apiKey: config.api.apiKey } });
        const uploaded = await api.uploadDelivery(
          args.job,
          new Blob([args.content], { type: args.contentType ?? 'text/plain' }),
        );
        if (!uploaded.success) throw new Error(`teslim yüklenemedi: ${uploaded.error.message}`);
        delivery = uploaded.data;
      } else {
        if (!args.deliveryUri || !args.workHash) throw new Error('content ya da deliveryUri + workHash verilmeli');
        delivery = { workHash: args.workHash, deliveryUri: args.deliveryUri };
      }
      const built = await client.flow.submitWork(
        {
          agent: account.agentWallet,
          job: new PublicKey(args.job),
          workHash: Buffer.from(delivery.workHash, 'hex'),
          deliveryUri: delivery.deliveryUri,
        },
        signing.options(account.agentWallet),
      );
      return { job: args.job, ...delivery, ...(await signing.complete(built, account.agentWallet)) };
    }),
  );

  server.registerTool(
    'square_send_transaction',
    {
      title: 'Send a signed transaction',
      description:
        'Broadcast a transaction returned by a Square write tool after the listed wallets signed it. A transaction ' +
        'with a missing signature is refused.',
      inputSchema: {
        transaction: z.string().min(1).describe('Signed v0 transaction, base64.'),
        lastValidBlockHeight: z.number().int().min(0).describe('From the write tool result.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded(({ transaction, lastValidBlockHeight }) => signing.send(transaction, lastValidBlockHeight)),
  );
}
