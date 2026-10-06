// Squads v4 vault işlemi: aç, öner, iki üye onaylar, ilk üye yürütür. Önceki koşudan yarıda kalan işlem varsa
// eksik adımlarından sürdürülür. Config kurulumu (`init-configs.mjs`) ve program upgrade'i (`upgrade-program.mjs`)
// bu akışı kullanır ([upgrade runbook'u](../../docs/runbooks/upgrade.md)).
import * as multisig from '@sqds/multisig';
import { TransactionMessage } from '@solana/web3.js';

export const VAULT_INDEX = 0;

/**
 * Programa giden, yürütülmemiş son vault işlemi: önceki koşu yarıda kaldıysa onun indeksi, yoksa null.
 * Yalnızca multisig'in son işlemine bakılır; daha eskisi başka bir işin önerisidir.
 */
export async function pendingIndex(connection, multisigPda, programId) {
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const index = BigInt(account.transactionIndex.toString());
  if (index === 0n) return null;
  const [transactionPda] = multisig.getTransactionPda({ multisigPda, index });
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: index });
  const transaction = await multisig.accounts.VaultTransaction.fromAccountAddress(connection, transactionPda);
  const programs = transaction.message.instructions.map((ix) => transaction.message.accountKeys[ix.programIdIndex]);
  if (!programs.some((key) => key.equals(programId))) return null;
  const proposal = await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda).catch(() => null);
  if (proposal && proposal.status.__kind !== 'Active' && proposal.status.__kind !== 'Approved') return null;
  return { index, proposal };
}

/**
 * Vault işlemi: aç, öner, iki onay, yürüt. Önceki koşudan kalan işlem varsa eksik adımlarından sürdürülür.
 * Atılan adımların imzaları döner.
 */
export async function throughVault(connection, multisigPda, vault, instruction, programId, [first, second]) {
  const confirm = async (signature) => {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) throw new Error(`${signature}: ${JSON.stringify(result.value.err)}`);
    return signature;
  };
  const pending = await pendingIndex(connection, multisigPda, programId);
  const account = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const transactionIndex = pending?.index ?? BigInt(account.transactionIndex.toString()) + 1n;
  const common = { connection, feePayer: first, multisigPda, transactionIndex };
  const steps = { transactionIndex: transactionIndex.toString(), resumed: pending !== null };
  if (!pending) {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const transactionMessage = new TransactionMessage({
      payerKey: vault,
      recentBlockhash: blockhash,
      instructions: [instruction],
    });
    steps.create = await confirm(
      await multisig.rpc.vaultTransactionCreate({
        ...common,
        creator: first.publicKey,
        vaultIndex: VAULT_INDEX,
        ephemeralSigners: 0,
        transactionMessage,
      }),
    );
  }
  if (!pending?.proposal)
    steps.propose = await confirm(await multisig.rpc.proposalCreate({ ...common, creator: first }));
  const approved = (pending?.proposal?.approved ?? []).map((key) => key.toBase58());
  steps.approvals = [];
  for (const member of [first, second]) {
    if (approved.includes(member.publicKey.toBase58())) continue;
    steps.approvals.push(await confirm(await multisig.rpc.proposalApprove({ ...common, member })));
  }
  steps.execute = await confirm(await multisig.rpc.vaultTransactionExecute({ ...common, member: first.publicKey }));
  return steps;
}
