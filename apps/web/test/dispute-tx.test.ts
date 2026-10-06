// Uyuşmazlık tx'leri (FE-17): sayfanın SDK akışına verdiği hesaplarla kurulan `raise_dispute`, `lapse_dispute`,
// `execute_resolution`, `escalate_missing_proof` ve arbitrator oyunun denetimi. Tx'ler sahte zincirde (yalnızca
// hesaplar ve blockhash) kurulur, gönderilmez; talimatlar escrow IDL'iyle çözülür.
import { BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type PublicKey,
} from '@solana/web3.js';
import { createPda, SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { decodeUnsignedTransaction, parseSplitAmount, voteRequest, voteTransactionProblem } from '@/lib/arbitration';
import { resolutionOf, toAnchorResolution } from '@/lib/dispute';
import { bytesToHex } from '@/lib/policy-draft';
import { settlementAccount } from '@/lib/settlement';
import { encodeConfig, encodeJob, fakeClient, FakeChain, key } from './helpers/escrow-accounts';

const instructions = new BorshInstructionCoder(SQUARE_IDLS.escrow as unknown as Idl);
const escrow = key();
const [institution, agentWallet, mint, arbitrator] = [key(), key(), key(), key()];
const job = key();
const pda = createPda({ registry: key(), policy: key(), verifier: key(), escrow });
const token = { mint, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 };

/** Tx'teki escrow talimatı: adı, argümanları ve hesapları. */
function escrowInstruction(transaction: VersionedTransaction) {
  const message = transaction.message;
  const keys = message.staticAccountKeys;
  const ix = message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(escrow))!;
  const decoded = instructions.decode(Buffer.from(ix.data))!;
  return {
    name: decoded.name,
    data: decoded.data as Record<string, unknown>,
    accounts: ix.accountKeyIndexes.map((i) => keys[i]!.toBase58()),
    feePayer: keys[0]!.toBase58(),
  };
}

async function chainWith(jobFields: Partial<Parameters<typeof encodeJob>[0]> = {}) {
  const chain = new FakeChain();
  chain.put(job, await encodeJob({ institution, agent_wallet: agentWallet, mint, ...jobFields }), escrow);
  chain.put(pda.escrowConfig()[0], await encodeConfig({ arbitrators: [arbitrator, key()], threshold: 2 }), escrow);
  chain.mint(mint);
  return { chain, client: fakeClient(chain, escrow) };
}

const b58 = (k: PublicKey) => k.toBase58();

describe('raise_dispute', () => {
  it('locks the bond from the institution’s USDC account into the job’s bond vault', async () => {
    const { client } = await chainWith();
    const reasonHash = Uint8Array.from({ length: 32 }, (_, i) => i);
    // Sayfa böyle çağırır (job-dispute.tsx): bond taban birimde, token hesabı kurumun ATA'sı.
    const built = await client.flow.raiseDispute(
      {
        institution,
        job,
        reasonHash,
        bond: 12_500_000n,
        institutionTokenAccount: settlementAccount(institution, token),
      },
      { feePayer: institution },
    );
    const ix = escrowInstruction(built.transaction);
    expect(ix.name).toBe('raise_dispute');
    expect(bytesToHex(Uint8Array.from(ix.data.reason_hash as number[]))).toBe(bytesToHex(reasonHash));
    expect(String(ix.data.bond)).toBe('12500000');
    expect(ix.feePayer).toBe(b58(institution));
    expect(ix.accounts).toEqual([
      b58(institution), // payer
      b58(institution),
      b58(pda.escrowConfig()[0]),
      b58(job),
      b58(pda.bondVault(job)[0]),
      b58(getAssociatedTokenAddressSync(mint, institution, false, TOKEN_PROGRAM_ID)),
      b58(mint),
      b58(TOKEN_PROGRAM_ID),
      b58(SystemProgram.programId),
    ]);
  });
});

describe('lapse_dispute and execute_resolution', () => {
  const dispute = { challenger: institution, bond: 12_500_000, raised_at: 1_000, deadline: 2_000 };

  it('lapses with the bond vault and refunds into the institution’s account', async () => {
    const { client } = await chainWith({ status: 'disputed', dispute });
    const caller = key();
    const built = await client.flow.lapseDispute({ caller, job }, { feePayer: caller });
    const ix = escrowInstruction(built.transaction);
    expect(ix.name).toBe('lapse_dispute');
    expect(ix.feePayer).toBe(b58(caller));
    expect(ix.accounts.slice(0, 5)).toEqual([
      b58(caller),
      b58(pda.escrowConfig()[0]),
      b58(job),
      b58(pda.bondVault(job)[0]),
      b58(getAssociatedTokenAddressSync(mint, institution, true, TOKEN_PROGRAM_ID)),
    ]);
  });

  it('lapses a bondless escalation without a bond vault', async () => {
    const { client } = await chainWith({
      status: 'disputed',
      dispute: { ...dispute, challenger: agentWallet, bond: 0 },
    });
    const caller = key();
    const ix = escrowInstruction((await client.flow.lapseDispute({ caller, job }, { feePayer: caller })).transaction);
    // Anchor'ın opsiyonel hesabı yoksa program kimliği yazılır.
    expect(ix.accounts[3]).toBe(b58(escrow));
  });

  it('executes a decision for anyone, with the payee and bond accounts', async () => {
    const { client } = await chainWith({ status: 'resolved', dispute: { ...dispute, resolution: { FavorAgent: {} } } });
    const caller = key();
    const ix = escrowInstruction(
      (await client.flow.executeResolution({ caller, job }, { feePayer: caller })).transaction,
    );
    expect(ix.name).toBe('execute_resolution');
    expect(ix.feePayer).toBe(b58(caller));
    expect(ix.accounts[0]).toBe(b58(caller));
    expect(ix.accounts).toContain(b58(pda.bondVault(job)[0]));
    expect(ix.accounts).toContain(b58(getAssociatedTokenAddressSync(mint, agentWallet, true, TOKEN_PROGRAM_ID)));
  });
});

describe('escalate_missing_proof', () => {
  it('is signed by the agent wallet and reads the job’s release proof', async () => {
    const chain = new FakeChain();
    const verifier = key();
    const client = fakeClient(chain, escrow, verifier);
    const ix = escrowInstruction(
      (await client.flow.escalateMissingProof({ agent: agentWallet, job }, { feePayer: agentWallet })).transaction,
    );
    const releaseProof = createPda({ registry: key(), policy: key(), verifier, escrow }).releaseProof(job)[0];
    expect(ix.name).toBe('escalate_missing_proof');
    expect(ix.accounts).toEqual([b58(agentWallet), b58(pda.escrowConfig()[0]), b58(job), b58(releaseProof)]);
  });
});

describe('the arbitrator’s vote', () => {
  const config = pda.escrowConfig()[0];
  const expected = (resolution = { kind: 'favorAgent' } as const) => ({
    escrowProgramId: escrow,
    config,
    arbitrator,
    job,
    resolution,
  });
  // API'nin döndürdüğü gibi: imzasız v0 tx, base64.
  const fromApi = (transaction: VersionedTransaction) =>
    decodeUnsignedTransaction(Buffer.from(transaction.serialize()).toString('base64'));

  it('asks the API for the chosen decision, paid by the arbitrator', () => {
    expect(voteRequest({ kind: 'split', agentAmount: '5' })).toEqual({
      resolution: { kind: 'split', agentAmount: '5' },
      feePayer: null,
      computeUnitPrice: null,
    });
  });

  it('accepts the resolve_dispute the API prepared for this vote', async () => {
    const { client } = await chainWith();
    const built = await client.flow.resolveDispute(
      { arbitrator, job, resolution: toAnchorResolution({ kind: 'favorAgent' }) },
      { feePayer: arbitrator },
    );
    expect(voteTransactionProblem(fromApi(built.transaction), expected())).toBeNull();
    const split = await client.flow.resolveDispute(
      { arbitrator, job, resolution: toAnchorResolution({ kind: 'split', agentAmount: '40' }) },
      { feePayer: arbitrator },
    );
    expect(
      voteTransactionProblem(fromApi(split.transaction), expected({ kind: 'split', agentAmount: '40' } as never)),
    ).toBeNull();
    const decoded = escrowInstruction(split.transaction);
    expect(resolutionOf(decoded.data.resolution)).toEqual({ kind: 'split', agentAmount: '40' });
  });

  it('refuses a transaction that is not exactly that vote', async () => {
    const { client } = await chainWith();
    const vote = async (resolution: Parameters<typeof toAnchorResolution>[0], signer = arbitrator, target = job) =>
      fromApi(
        (
          await client.flow.resolveDispute(
            { arbitrator: signer, job: target, resolution: toAnchorResolution(resolution) },
            { feePayer: signer },
          )
        ).transaction,
      );
    expect(voteTransactionProblem(await vote({ kind: 'favorInstitution' }), expected())).toMatch(/another decision/);
    expect(voteTransactionProblem(await vote({ kind: 'favorAgent' }, arbitrator, key()), expected())).toMatch(
      /another job/,
    );
    expect(voteTransactionProblem(await vote({ kind: 'favorAgent' }, key()), expected())).toMatch(/fee payer/);

    // Oya eklenmiş bir transfer: imzalanmaz.
    const honest = await vote({ kind: 'favorAgent' });
    const keys = honest.message.staticAccountKeys;
    const voteIx = honest.message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(escrow))!;
    const message = new TransactionMessage({
      payerKey: arbitrator,
      recentBlockhash: honest.message.recentBlockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        {
          programId: escrow,
          keys: voteIx.accountKeyIndexes.map((i) => ({ pubkey: keys[i]!, isSigner: i === 0, isWritable: i !== 1 })),
          data: Buffer.from(voteIx.data),
        },
        SystemProgram.transfer({ fromPubkey: arbitrator, toPubkey: key(), lamports: 1 }),
      ],
    }).compileToV0Message();
    expect(voteTransactionProblem(new VersionedTransaction(message), expected())).toMatch(/program other than/);
  });

  it('keeps a split within the escrowed amount', () => {
    expect(parseSplitAmount('100', 6, 250_000_000n)).toEqual({ ok: true, value: 100_000_000n });
    expect(parseSplitAmount('250.000001', 6, 250_000_000n)).toMatchObject({ ok: false });
    expect(parseSplitAmount('251', 6, 250_000_000n)).toEqual({
      ok: false,
      error: 'The agent’s share cannot exceed the escrowed amount.',
    });
  });
});
