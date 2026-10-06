// Test fixture: Square talimatları (IDL discriminator'ı ve hesap sırasıyla; argümanlar politikanın konusu değil),
// v0 tx kurma ve imzalama yardımcıları.
import { SQUARE_IDLS, type SquareProgramName } from '@squaresdk/solana-sdk';
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { PROGRAM_IDS } from './stack.js';

export const key = () => Keypair.generate().publicKey;
export const BLOCKHASH = bs58.encode(Buffer.alloc(32, 9));

interface IdlIx {
  name: string;
  discriminator: number[];
  accounts: { name: string; signer?: boolean; writable?: boolean }[];
}

/** Square talimatı: `accounts` adla verilir, verilmeyen hesaplar rastgele adrestir. */
export function squareIx(
  program: SquareProgramName,
  name: string,
  accounts: Record<string, PublicKey> = {},
  extra: Uint8Array = new Uint8Array(),
): TransactionInstruction {
  const idl = SQUARE_IDLS[program] as unknown as { instructions: IdlIx[] };
  const ix = idl.instructions.find((candidate) => candidate.name === name);
  if (!ix) throw new Error(`${program}:${name} yok`);
  const unknown = Object.keys(accounts).filter((account) => !ix.accounts.some((a) => a.name === account));
  if (unknown.length > 0) throw new Error(`${name} hesapları: ${unknown.join(', ')}`);
  return new TransactionInstruction({
    programId: PROGRAM_IDS[program],
    keys: ix.accounts.map((account) => ({
      pubkey: accounts[account.name] ?? key(),
      isSigner: account.signer ?? false,
      isWritable: account.writable ?? false,
    })),
    data: Buffer.concat([Buffer.from(ix.discriminator), Buffer.from(extra)]),
  });
}

export function v0(
  payer: PublicKey,
  instructions: readonly TransactionInstruction[],
  tables: readonly AddressLookupTableAccount[] = [],
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [...instructions],
  }).compileToV0Message([...tables]);
  return new VersionedTransaction(message);
}

/** İmzacıların imzası (sponsor hariç: onun yeri boş kalır). */
export function signed(tx: VersionedTransaction, ...signers: Keypair[]): VersionedTransaction {
  if (signers.length > 0) tx.sign(signers);
  return tx;
}

export const encode = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString('base64');

export function table(addresses: readonly PublicKey[], address = key()): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: address,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [...addresses],
    },
  });
}
