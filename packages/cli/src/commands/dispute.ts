// Uyuşmazlık (ADR 0016): kurumun itirazı, arbitrator oyu, kararın ödenmesi, son tarihi geçen dispute'un düşürülmesi
// ve agent'ın ispatsız bekleme başvurusu.
import { sha256 } from '@noble/hashes/sha2';
import BN from 'bn.js';
import { address, amount, bytes32, CliError, readBytes, required } from '../io.js';
import { fetchJob, tokenAccount } from './job.js';
import { str, type Command } from './types.js';

const JOB = { job: { type: 'string' } } as const;
const BPS = 10_000n;

const raise: Command = {
  group: 'dispute',
  action: 'raise',
  summary: 'challenge penceresinde teslime itiraz; bond kurumun token hesabından kilitlenir (imzacı kurum)',
  usage: [
    ['--job <adres>', 'job'],
    ['--evidence <yol>', 'kanıt dosyası; reasonHash SHA-256 (ya da --reason-hash <hex>)'],
    ['--bond <taban birim>', 'verilmezse en düşük bond: max(tutar × min_bond_bps / 10 000, min_bond_absolute)'],
  ],
  options: { ...JOB, evidence: { type: 'string' }, 'reason-hash': { type: 'string' }, bond: { type: 'string' } },
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const evidence = str(values, 'evidence');
    const given = str(values, 'reason-hash');
    if ((evidence === undefined) === (given === undefined)) throw new CliError('--evidence ya da --reason-hash (biri)');
    const reasonHash = evidence ? sha256(readBytes(evidence, 'kanıt')) : bytes32(given, 'reason-hash');
    const account = await fetchJob(ctx, job);
    let bond: bigint;
    if (str(values, 'bond') !== undefined) {
      bond = amount(str(values, 'bond'), 'bond');
    } else {
      const config = await ctx.client.escrow.fetch('escrowConfig', ctx.client.pda.escrowConfig()[0]);
      if (!config) throw new CliError('escrow config bulunamadı');
      const relative = (BigInt(account.amount.toString()) * BigInt(config.params.minBondBps)) / BPS;
      const absolute = BigInt(config.params.minBondAbsolute.toString());
      bond = relative > absolute ? relative : absolute;
    }
    const { ata } = await tokenAccount(ctx, ctx.signer.publicKey, account.mint);
    const { signature } = await ctx.send('raise_dispute', () =>
      ctx.client.flow.raiseDispute(
        { institution: ctx.signer.publicKey, job, reasonHash, bond, institutionTokenAccount: ata },
        ctx.options(),
      ),
    );
    return { signature, job, reasonHash, bond };
  },
};

const RESOLUTIONS = ['favor-agent', 'favor-institution', 'split'] as const;

const vote: Command = {
  group: 'dispute',
  action: 'vote',
  summary: 'arbitrator oyu; eşik dolunca karar kesinleşir (imzacı arbitrator)',
  usage: [
    ['--job <adres>', 'job'],
    ['--resolution <karar>', RESOLUTIONS.join(' | ')],
    ['--agent-amount <birim>', 'split: agent tarafına ödenecek tutar'],
  ],
  options: { ...JOB, resolution: { type: 'string' }, 'agent-amount': { type: 'string' } },
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const choice = required(str(values, 'resolution'), 'resolution');
    if (!(RESOLUTIONS as readonly string[]).includes(choice))
      throw new CliError(`--resolution ${RESOLUTIONS.join(' | ')}`);
    const resolution =
      choice === 'favor-agent'
        ? { favorAgent: {} }
        : choice === 'favor-institution'
          ? { favorInstitution: {} }
          : { split: { agentAmount: new BN(amount(str(values, 'agent-amount'), 'agent-amount').toString()) } };
    const { signature } = await ctx.send('resolve_dispute', () =>
      ctx.client.flow.resolveDispute(
        { arbitrator: ctx.signer.publicKey, job, resolution: resolution as never },
        ctx.options(),
      ),
    );
    const account = await fetchJob(ctx, job);
    return {
      signature,
      job,
      resolution: choice,
      approvals: account.dispute.approvalCount,
      status: Object.keys(account.status)[0],
    };
  },
};

const execute: Command = {
  group: 'dispute',
  action: 'execute',
  summary: 'kesinleşmiş kararı öder; permissionless',
  usage: [['--job <adres>', 'dispute açık job']],
  options: JOB,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const { signature } = await ctx.send('execute_resolution', () =>
      ctx.client.flow.executeResolution({ caller: ctx.signer.publicKey, job }, ctx.options()),
    );
    return { signature, job, status: Object.keys((await fetchJob(ctx, job)).status)[0] };
  },
};

const lapse: Command = {
  group: 'dispute',
  action: 'lapse',
  summary: "son tarihi geçmiş, karara bağlanmamış dispute'u düşürür; bond kuruma döner (permissionless)",
  usage: [['--job <adres>', 'dispute açık job']],
  options: JOB,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const { signature } = await ctx.send('lapse_dispute', () =>
      ctx.client.flow.lapseDispute({ caller: ctx.signer.publicKey, job }, ctx.options()),
    );
    return { signature, job, status: Object.keys((await fetchJob(ctx, job)).status)[0] };
  },
};

const escalate: Command = {
  group: 'dispute',
  action: 'escalate',
  summary: "policy'li işte ispat bağlanmadıysa agent'ın bond'suz dispute başvurusu (imzacı agent cüzdanı)",
  usage: [['--job <adres>', 'dispute açık job']],
  options: JOB,
  async run(ctx, values) {
    const job = address(str(values, 'job'), 'job');
    const { signature } = await ctx.send('escalate_missing_proof', () =>
      ctx.client.flow.escalateMissingProof({ agent: ctx.signer.publicKey, job }, ctx.options()),
    );
    return { signature, job };
  },
};

export const DISPUTE_COMMANDS: readonly Command[] = [raise, vote, execute, lapse, escalate];
