// Yazma tool'ları: job aç (create_job → gerekirse commit_travel_rule → fund_job), işe al (accept_job),
// teslim et (yükleme + submit_work) ve imzalı tx gönderimi. İmzasız tx'i API'nin `POST /v1/tx` ucu hazırlar
// (hesap çözümü, compute unit sınırı, simülasyon sunucuda); tool tx'i base64 ve çözülmüş özetiyle döner.
// Sunucu özel anahtar tutmaz ve imzasız tx göndermez: gönderim yalnızca `square_submit_signed_transaction`
// ile ve her zorunlu imza doğrulandıktan sonra olur (transactions.ts). Yerel imzalayıcı yapılandırılmışsa
// `sign: true` tx'i o anahtarla imzalayıp aynı yoldan gönderir.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { specHashing } from '@squaresdk/solana-sdk';
import { Address, Hex32, U64, type InstructionCall, type UnsignedTx } from '@squaresdk/solana-types';
import { z } from 'zod';
import { unwrap, unwrapOrNull } from '../api.js';
import type { SquareChain } from '../chain.js';
import {
  checkSignatures,
  decodeTransaction,
  knownPrograms,
  submitSigned,
  summarize,
  type LocalSigner,
} from '../transactions.js';
import { ToolInputError, guarded, type ToolContext } from './result.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const common = {
  feePayer: Address.optional().describe('Fee payer wallet (default: the acting wallet).'),
  computeUnitPrice: U64.optional().describe('Priority fee in micro-lamports per compute unit (default: API setting).'),
  sign: z
    .boolean()
    .optional()
    .describe('Sign with the locally configured signer and submit. Only available when the server has one.'),
};

const SIGNING_NOTE =
  'This transaction is UNSIGNED and was not sent. Every wallet in summary.requiredSigners must sign it ' +
  '(e.g. in the user wallet), then pass the signed transaction (base64) to square_submit_signed_transaction ' +
  'before lastValidBlockHeight. The server never sends an unsigned transaction.';

interface WriteDeps {
  ctx: ToolContext;
  chain: SquareChain;
  signer: LocalSigner | null;
}

/** Cüzdan girdisi; verilmemişse yerel imzalayıcının adresi. */
function actor(value: string | undefined, signer: LocalSigner | null, label: string): string {
  if (value) return value;
  if (signer) return signer.publicKey.toBase58();
  throw new ToolInputError(`${label} is required (no local signer is configured)`);
}

/** API'de tx hazırlar; özetler ve `sign` istenmişse yerel imzalayıcıyla imzalayıp gönderir. */
async function prepare(
  deps: WriteDeps,
  call: InstructionCall,
  accounts: Record<string, string>,
  feePayer: string,
  options: { computeUnitPrice: string | undefined; sign: boolean | undefined },
) {
  const unsigned: UnsignedTx = (
    await unwrap(
      deps.ctx.api.prepareTx({ call, accounts, feePayer, computeUnitPrice: options.computeUnitPrice ?? null }),
    )
  ).data;
  const tx = decodeTransaction(unsigned.transaction);
  const programs = knownPrograms(deps.chain.escrowProgramId);
  const summary = summarize(tx, programs);
  if (summary.feePayer !== feePayer) {
    throw new Error(`prepared transaction has fee payer ${summary.feePayer}, expected ${feePayer}`);
  }
  if (!summary.instructions.some((ix) => ix.program === 'square_escrow')) {
    throw new Error('prepared transaction does not call the configured square_escrow program');
  }
  const prepared = {
    instruction: call.instruction,
    transaction: unsigned.transaction,
    blockhash: unsigned.blockhash,
    lastValidBlockHeight: unsigned.lastValidBlockHeight,
    computeUnitLimit: unsigned.computeUnitLimit,
    simulatedUnits: unsigned.simulatedUnits,
    summary,
  };
  if (!options.sign) return { ...prepared, signed: false, submitted: null, note: SIGNING_NOTE };

  if (!deps.signer) throw new ToolInputError('sign: true needs a local signer (SQUARE_SIGNER_KEYPAIR) on the server');
  deps.signer.sign(tx);
  const signatures = checkSignatures(tx);
  if (signatures.some((check) => check.status !== 'valid')) {
    // Başka imzacı da gerekiyor: kısmen imzalı tx döner, gönderilmez.
    return {
      ...prepared,
      transaction: Buffer.from(tx.serialize()).toString('base64'),
      summary: summarize(tx, programs),
      signed: 'partial',
      submitted: null,
      note: 'Signed by the local signer only; the remaining signers must sign before square_submit_signed_transaction.',
    };
  }
  const submitted = await submitSigned(deps.chain, tx);
  return { ...prepared, transaction: Buffer.from(tx.serialize()).toString('base64'), signed: true, submitted };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export function registerWriteTools(server: McpServer, deps: WriteDeps): void {
  const { ctx, chain, signer } = deps;
  const { api } = ctx;

  server.registerTool(
    'square_open_job',
    {
      title: 'Open job',
      description: [
        'Open a Square job as an institution: create it bound to an agent and lock the escrow. Opening takes',
        'separate transactions, and this tool returns the next one each time it is called with the same spec:',
        'create_job (job does not exist), commit_travel_rule (amount at or above the Travel Rule threshold and',
        'no commitment yet; pass travelRuleCommitment), then fund_job (moves the amount from the institution',
        "token account into the job's vault). Each returned transaction is unsigned: sign it with the",
        'institution wallet (and fee payer), submit it with square_submit_signed_transaction, wait for',
        'confirmation, then call this tool again for the next step. The job address is derived from the',
        'institution and the spec hash (RFC 8785 JSON + SHA-256).',
      ].join(' '),
      inputSchema: {
        institution: Address.optional().describe('Institution key that signs (default: the local signer).'),
        agentRecord: Address.describe('AgentRecord of the agent the job is bound to.'),
        spec: z.record(z.string(), z.unknown()).describe('Job spec as a JSON object; its hash identifies the job.'),
        amount: U64.describe('Escrow amount in base units of the settlement mint.'),
        deadline: z.number().int().positive().describe('Delivery deadline, unix seconds.'),
        challengePeriod: U64.describe('Challenge window after delivery, seconds (within the escrow limits).'),
        policy: Address.optional().describe('Institution policy to bind (snapshot taken at create).'),
        travelRuleCommitment: Hex32.optional().describe('32-byte hex Travel Rule commitment, when required.'),
        ...common,
      },
      annotations: { title: 'Open job', ...WRITE },
    },
    guarded(async (args) => {
      const institution = actor(args.institution, signer, 'institution');
      const feePayer = args.feePayer ?? institution;
      let specHash: Uint8Array;
      try {
        specHash = specHashing.specHash(args.spec);
      } catch (error) {
        throw new ToolInputError(
          `spec is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
          null,
          { cause: error },
        );
      }
      const job = chain.jobAddress(new PublicKey(institution), specHash);
      const settlement = await chain.settlement();
      const amount = BigInt(args.amount);
      const needsTravelRule = settlement.travelRuleThreshold > 0n && amount >= settlement.travelRuleThreshold;
      const base = {
        job: job.toBase58(),
        specHash: hex(specHash),
        settlement: {
          mint: settlement.mint.toBase58(),
          decimals: settlement.decimals,
          travelRuleThreshold: settlement.travelRuleThreshold,
        },
      };
      const sendOptions = { computeUnitPrice: args.computeUnitPrice, sign: args.sign };
      const existing = await chain.job(job);

      if (!existing) {
        const accounts: Record<string, string> = {
          payer: feePayer,
          institution,
          agentRecord: args.agentRecord,
          mint: settlement.mint.toBase58(),
          tokenProgram: settlement.tokenProgram.toBase58(),
        };
        if (args.policy) {
          const policy = await unwrapOrNull(api.getPolicy(args.policy));
          if (!policy) throw new ToolInputError(`policy ${args.policy} not found`);
          accounts.policy = args.policy;
          accounts.policyInstitution = policy.account.institution;
        }
        const call: InstructionCall = {
          program: 'escrow',
          instruction: 'createJob',
          args: {
            specHash: hex(specHash),
            amount: args.amount,
            deadline: args.deadline,
            challengePeriod: args.challengePeriod,
          },
        };
        return {
          step: 'createJob',
          nextStep: needsTravelRule ? 'commitTravelRule' : 'fundJob',
          ...base,
          ...(await prepare(deps, call, accounts, feePayer, sendOptions)),
        };
      }

      if (existing.institution.toBase58() !== institution) {
        throw new ToolInputError(`job ${job.toBase58()} belongs to another institution`);
      }
      if (existing.agentRecord.toBase58() !== args.agentRecord || existing.amount !== amount) {
        throw new ToolInputError(
          `job ${job.toBase58()} already exists for this spec with different terms (agentRecord ${existing.agentRecord.toBase58()}, amount ${existing.amount}); change the spec to open another job`,
        );
      }
      if (existing.status !== 'open') {
        return {
          step: 'done',
          nextStep: null,
          ...base,
          status: existing.status,
          note: 'The job is already funded; nothing to sign. The bound agent accepts it next.',
        };
      }
      if (needsTravelRule && !existing.travelRuleCommitted) {
        if (!args.travelRuleCommitment) {
          throw new ToolInputError(
            `amount ${amount} is at or above the Travel Rule threshold ${settlement.travelRuleThreshold}: pass travelRuleCommitment before funding`,
            { job: job.toBase58() },
          );
        }
        const call: InstructionCall = {
          program: 'escrow',
          instruction: 'commitTravelRule',
          args: { commitment: args.travelRuleCommitment },
        };
        return {
          step: 'commitTravelRule',
          nextStep: 'fundJob',
          ...base,
          ...(await prepare(deps, call, { institution, job: job.toBase58() }, feePayer, sendOptions)),
        };
      }
      const institutionTokenAccount = getAssociatedTokenAddressSync(
        existing.mint,
        new PublicKey(institution),
        true,
        settlement.tokenProgram,
      );
      const call: InstructionCall = { program: 'escrow', instruction: 'fundJob', args: {} };
      return {
        step: 'fundJob',
        nextStep: null,
        ...base,
        institutionTokenAccount: institutionTokenAccount.toBase58(),
        ...(await prepare(
          deps,
          call,
          {
            institution,
            job: job.toBase58(),
            institutionTokenAccount: institutionTokenAccount.toBase58(),
            tokenProgram: settlement.tokenProgram.toBase58(),
          },
          feePayer,
          sendOptions,
        )),
      };
    }),
  );

  /** API'deki job; durum ve agent cüzdanı denetlenir. */
  async function agentJob(address: string, agent: string, expected: 'funded' | 'accepted') {
    const view = await unwrapOrNull(api.getJob(address));
    if (!view) throw new ToolInputError(`job ${address} not found (it may not be indexed yet)`);
    if (view.account.status !== expected) {
      throw new ToolInputError(`job ${address} is ${view.account.status}, expected ${expected}`);
    }
    if (view.account.agentWallet !== agent) {
      throw new ToolInputError(`job ${address} is bound to agent wallet ${view.account.agentWallet}, not ${agent}`);
    }
    return view;
  }

  server.registerTool(
    'square_accept_job',
    {
      title: 'Accept job',
      description: [
        "Accept a funded Square job as its bound agent. Only the job's agentWallet can accept. Returns the",
        'unsigned accept_job transaction: sign it with the agent wallet and submit it with',
        'square_submit_signed_transaction. After acceptance the agent must deliver before the deadline.',
      ].join(' '),
      inputSchema: {
        job: Address.describe('Job PDA address.'),
        agent: Address.optional().describe("Agent wallet (the job's agentWallet; default: the local signer)."),
        ...common,
      },
      annotations: { title: 'Accept job', ...WRITE },
    },
    guarded(async (args) => {
      const agent = actor(args.agent, signer, 'agent');
      const view = await agentJob(args.job, agent, 'funded');
      const call: InstructionCall = {
        program: 'escrow',
        instruction: 'acceptJob',
        args: { specHash: view.account.specHash },
      };
      return {
        step: 'acceptJob',
        job: args.job,
        deadline: new Date(view.account.deadline * 1000).toISOString(),
        ...(await prepare(deps, call, { agent, job: args.job }, args.feePayer ?? agent, {
          computeUnitPrice: args.computeUnitPrice,
          sign: args.sign,
        })),
      };
    }),
  );

  server.registerTool(
    'square_deliver_work',
    {
      title: 'Deliver work',
      description: [
        'Deliver the work for an accepted Square job as its agent. Either pass content (uploaded through the',
        'Square API, which returns its SHA-256 workHash and public deliveryUri) or an already published',
        'workHash + deliveryUri. Returns the unsigned submit_work transaction: sign it with the agent wallet and',
        'submit it with square_submit_signed_transaction. Delivery starts the challenge window.',
      ].join(' '),
      inputSchema: {
        job: Address.describe('Job PDA address.'),
        agent: Address.optional().describe("Agent wallet (the job's agentWallet; default: the local signer)."),
        content: z.string().min(1).optional().describe('Delivery content to upload (UTF-8 text).'),
        contentType: z.string().min(1).max(120).optional().describe('Content type of content (default text/plain).'),
        workHash: Hex32.optional().describe('SHA-256 of an already uploaded delivery.'),
        deliveryUri: z.string().min(1).max(128).optional().describe('URI of an already uploaded delivery.'),
        ...common,
      },
      annotations: { title: 'Deliver work', ...WRITE },
    },
    guarded(async (args) => {
      const agent = actor(args.agent, signer, 'agent');
      const uploaded = args.content !== undefined;
      const published = args.workHash !== undefined || args.deliveryUri !== undefined;
      if (uploaded === published || (published && (!args.workHash || !args.deliveryUri))) {
        throw new ToolInputError('pass either content, or both workHash and deliveryUri');
      }
      await agentJob(args.job, agent, 'accepted');
      let receipt: { workHash: string; deliveryUri: string; size: number | null };
      if (uploaded) {
        const blob = new Blob([args.content!], { type: args.contentType ?? 'text/plain' });
        const { data } = await unwrap(api.uploadDelivery(args.job, blob));
        receipt = { workHash: data.workHash, deliveryUri: data.deliveryUri, size: data.size };
      } else {
        receipt = { workHash: args.workHash!, deliveryUri: args.deliveryUri!, size: null };
      }
      const call: InstructionCall = {
        program: 'escrow',
        instruction: 'submitWork',
        args: { workHash: receipt.workHash, deliveryUri: receipt.deliveryUri },
      };
      return {
        step: 'submitWork',
        job: args.job,
        delivery: receipt,
        ...(await prepare(deps, call, { agent, job: args.job }, args.feePayer ?? agent, {
          computeUnitPrice: args.computeUnitPrice,
          sign: args.sign,
        })),
      };
    }),
  );

  server.registerTool(
    'square_submit_signed_transaction',
    {
      title: 'Submit signed transaction',
      description: [
        'Submit a transaction prepared by a Square write tool after it has been signed. Every required signer',
        'signature is verified against the message first; a transaction with a missing or invalid signature is',
        'rejected and never sent. Returns the signature and its confirmation status.',
      ].join(' '),
      inputSchema: {
        transaction: z.string().min(1).describe('Signed v0 transaction, base64.'),
      },
      annotations: { title: 'Submit signed transaction', ...WRITE },
    },
    guarded(async ({ transaction }) => {
      let tx;
      try {
        tx = decodeTransaction(transaction);
      } catch (error) {
        throw new ToolInputError(error instanceof Error ? error.message : String(error), null, { cause: error });
      }
      const summary = summarize(tx, knownPrograms(chain.escrowProgramId));
      const submitted = await submitSigned(chain, tx);
      if (submitted.err !== null) {
        throw new ToolInputError(`transaction ${submitted.signature} failed on chain`, {
          signature: submitted.signature,
          err: submitted.err,
        });
      }
      return { network: ctx.network, ...submitted, summary };
    }),
  );
}
