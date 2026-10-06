// Test fixture: zincirdeki Squads hesaplarının verisi (resmi `@sqds/multisig` kodlayıcılarıyla). Squads programı
// testte yoktur; öneri işleminin zincirde bıraktığı VaultTransaction hesabı buradan yazılır.
import * as sqds from '@sqds/multisig';
import type { VaultMessage } from '@squaresdk/solana-sdk/squads';
import { SystemProgram, type PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

/** `VaultTransaction` hesap verisi: mesaj `vault_transaction_create`'in kaydettiğiyle aynı. */
export function vaultTransactionData(params: {
  multisig: PublicKey;
  creator: PublicKey;
  index: bigint;
  message: VaultMessage;
  vaultIndex?: number;
}): Buffer {
  const { message } = params;
  const [data] = sqds.accounts.VaultTransaction.fromArgs({
    multisig: params.multisig,
    creator: params.creator,
    index: new BN(params.index.toString()),
    bump: 255,
    vaultIndex: params.vaultIndex ?? 0,
    vaultBump: 255,
    ephemeralSignerBumps: new Uint8Array(),
    message: {
      numSigners: message.numSigners,
      numWritableSigners: message.numWritableSigners,
      numWritableNonSigners: message.numWritableNonSigners,
      accountKeys: [...message.accountKeys],
      instructions: message.instructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accountIndexes: Uint8Array.from(ix.accountIndexes),
        data: Uint8Array.from(ix.data),
      })),
      addressTableLookups: message.addressTableLookups.map((lookup) => ({
        accountKey: lookup.accountKey,
        writableIndexes: Uint8Array.from(lookup.writableIndexes),
        readonlyIndexes: Uint8Array.from(lookup.readonlyIndexes),
      })),
    },
  }).serialize();
  return data;
}

export function multisigData(params: { members: readonly PublicKey[]; rentCollector: PublicKey | null }): Buffer {
  const [data] = sqds.accounts.Multisig.fromArgs({
    createKey: params.members[0]!,
    configAuthority: SystemProgram.programId,
    threshold: 1,
    timeLock: 0,
    transactionIndex: new BN(0),
    staleTransactionIndex: new BN(0),
    rentCollector: params.rentCollector,
    bump: 255,
    members: params.members.map((key) => ({ key, permissions: { mask: 7 } })),
  }).serialize();
  return data;
}
