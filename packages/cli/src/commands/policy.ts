// Adım 1 ve 5 (kurum): politika sırrı, politikanın commitment'ı ve onaylı alıcı kökü (BE-10). Politika belgesi ve
// sır kurumun makinesinden çıkmaz; zincire yalnızca commitment, public tavan ve alıcı kökü gider.
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import {
  buildBuyerTree,
  computePolicyCommitment,
  derivePolicySalts,
  generateLeafSalt,
  generatePolicySecret,
  type PolicySalts,
} from '@squaresdk/solana-policy';
import { computeUnitLimitFor, withComputeProfile, type TxKind } from '@squaresdk/solana-sdk';
import { PolicyDocumentSchema, type PolicyDocument } from '@squaresdk/solana-types';
import BN from 'bn.js';
import type { Context } from '../context.js';
import { address, CliError, hex, readBytes, readJson, required, writePrivate } from '../io.js';
import { list, str, type Command, type Values } from './types.js';

/** Kurumun yerel politikası: belge, sırdan türeyen salt'lar ve politikanın zincirdeki adresi. */
export interface LocalPolicy {
  document: PolicyDocument;
  salts: PolicySalts;
  address: PublicKey;
  institution: PublicKey;
  policyId: Uint8Array;
}

/** Sır dosyası: 32 baytlık hex (`policy secret` yazar). */
function readSecret(path: string): Uint8Array {
  const text = new TextDecoder().decode(readBytes(path, 'politika sırrı')).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new CliError(`politika sırrı 32 baytlık hex değil: ${path}`);
  return Uint8Array.from(Buffer.from(text, 'hex'));
}

/** `--policy` ve `--secret` dosyalarından yerel politika; belgenin kurumu imzacının `Institution` PDA'sı olmalı. */
export function loadPolicy(ctx: Context, values: Values): LocalPolicy {
  const parsed = PolicyDocumentSchema.safeParse(readJson(required(str(values, 'policy'), 'policy'), 'politika'));
  if (!parsed.success) {
    throw new CliError(
      `politika belgesi geçersiz: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const document = parsed.data;
  const institution = new PublicKey(document.institution);
  const policyId = Uint8Array.from(Buffer.from(document.policyId, 'hex'));
  const secret = readSecret(required(str(values, 'secret'), 'secret'));
  return {
    document,
    salts: derivePolicySalts(secret, policyId),
    address: ctx.client.pda.policy(institution, policyId)[0],
    institution,
    policyId,
  };
}

/** İmzacının kurumu: belgedeki kurum imzacının `Institution` PDA'sı değilse hata. */
function requireOwnInstitution(ctx: Context, policy: LocalPolicy): void {
  const own = ctx.client.pda.institution(ctx.signer.publicKey)[0];
  if (!own.equals(policy.institution)) {
    throw new CliError(
      `politikanın kurumu ${policy.institution.toBase58()}, imzacının kurumu ${own.toBase58()} (multisig'li kurum Squads ile imzalar)`,
    );
  }
}

const secret: Command = {
  group: 'policy',
  action: 'secret',
  summary: "adım 1: politika sırrı (salt'lar bundan türer; kurumda kalır)",
  usage: [['--out <yol>', 'sırrın yazılacağı dosya (0600, üstüne yazılmaz)']],
  options: { out: { type: 'string' } },
  async run(_ctx, values) {
    const path = writePrivate(required(str(values, 'out'), 'out'), `${hex(generatePolicySecret())}\n`);
    return { secret: path };
  },
};

const commit: Command = {
  group: 'policy',
  action: 'commit',
  summary: "adım 1: kurum (yoksa) ve politikanın commitment'ı + public tavanı (imzacı kurumun yetkilisi)",
  usage: [
    ['--policy <yol>', 'politika belgesi (JSON, @squaresdk/solana-types PolicyDocument)'],
    ['--secret <yol>', 'politika sırrı'],
    ['--name <ad>', 'kurumun adı; kurum henüz yoksa gerekli (en fazla 64 bayt)'],
  ],
  options: { policy: { type: 'string' }, secret: { type: 'string' }, name: { type: 'string' } },
  async run(ctx, values) {
    const policy = loadPolicy(ctx, values);
    requireOwnInstitution(ctx, policy);
    const { client } = ctx;
    const authority = ctx.signer.publicKey;
    const commitment = Array.from(computePolicyCommitment(policy.document, policy.salts));
    const ceiling = new BN(policy.document.dailyCeiling);
    const instructions: TransactionInstruction[] = [];
    const kinds: TxKind[] = [];
    if (!(await client.policy.fetch('institution', policy.institution))) {
      const name = required(str(values, 'name'), 'name');
      instructions.push(
        await client.policy.program.methods
          .initInstitution(name)
          .accountsStrict({
            payer: ctx.feePayer.publicKey,
            authority,
            institution: policy.institution,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      kinds.push('initInstitution');
    }
    const existing = await client.policy.fetch('policy', policy.address);
    if (existing) {
      instructions.push(
        await client.policy.program.methods
          .updatePolicy(commitment, ceiling)
          .accountsStrict({ authority, institution: policy.institution, policy: policy.address })
          .instruction(),
      );
      kinds.push('updatePolicy');
    } else {
      instructions.push(
        await client.policy.program.methods
          .setPolicy(Array.from(policy.policyId), commitment, ceiling)
          .accountsStrict({
            payer: ctx.feePayer.publicKey,
            authority,
            institution: policy.institution,
            policy: policy.address,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      );
      kinds.push('setPolicy');
    }
    const { signature } = await ctx.send(kinds.join(' + '), () =>
      client.buildTx(instructions, { ...ctx.options(), computeUnitLimit: computeUnitLimitFor(kinds) }),
    );
    const account = await client.policy.fetch('policy', policy.address);
    return {
      signature,
      institution: policy.institution,
      policy: policy.address,
      commitment: Uint8Array.from(commitment),
      dailyCeiling: policy.document.dailyCeiling,
      version: account?.version ?? null,
    };
  },
};

const buyers: Command = {
  group: 'policy',
  action: 'buyers',
  summary: "adım 5: onaylı alıcı listesinin kökü; liste ve salt'lar dosyaya yazılır (alıcılara kanıt için)",
  usage: [
    ['--policy <yol>', 'politika belgesi'],
    ['--secret <yol>', 'politika sırrı'],
    ['--buyer <adres>', 'onaylı alıcı (birden çok kez)'],
    ['--out <yol>', "liste dosyası: alıcılar, salt'ları ve kök (0600, üstüne yazılmaz)"],
  ],
  options: {
    policy: { type: 'string' },
    secret: { type: 'string' },
    buyer: { type: 'string', multiple: true },
    out: { type: 'string' },
  },
  async run(ctx, values) {
    const policy = loadPolicy(ctx, values);
    requireOwnInstitution(ctx, policy);
    const out = required(str(values, 'out'), 'out');
    const entries = list(values, 'buyer').map((b) => ({ buyer: address(b, 'buyer'), leafSalt: generateLeafSalt() }));
    if (entries.length === 0) throw new CliError('en az bir --buyer gerekli');
    const tree = buildBuyerTree(entries);
    const file = {
      policy: policy.address.toBase58(),
      root: hex(tree.root),
      buyers: entries.map((e) => ({ buyer: e.buyer.toBase58(), leafSalt: hex(e.leafSalt) })),
    };
    const path = writePrivate(out, `${JSON.stringify(file, null, 2)}\n`);
    const { signature } = await ctx.send('set_buyer_root', async () =>
      ctx.client.buildTx(
        [
          await ctx.client.policy.program.methods
            .setBuyerRoot(Array.from(tree.root))
            .accountsStrict({
              authority: ctx.signer.publicKey,
              institution: policy.institution,
              policy: policy.address,
            })
            .instruction(),
        ],
        withComputeProfile(ctx.options(), 'setBuyerRoot'),
      ),
    );
    return { signature, policy: policy.address, buyerRoot: tree.root, buyers: entries.length, file: path };
  },
};

export const POLICY_COMMANDS: readonly Command[] = [secret, commit, buyers];
