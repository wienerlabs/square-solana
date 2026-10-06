// İmza akışı. Sunucu özel anahtar tutmaz: yazma tool'ları API'nin hazırladığı imzasız v0 tx'i ve özetini
// döner, imzalı tx `square_submit_signed_transaction` ile gelir. Gönderimden önce her zorunlu imzacının
// imzası mesaj baytlarına karşı Ed25519 ile doğrulanır; eksik ya da geçersiz imzalı tx RPC'ye hiç gitmez.
// İsteğe bağlı yerel imzalayıcı yalnızca açıkça verilen keypair dosyasıyla çalışır (config.ts).
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Idl, IdlType } from '@anchor-lang/core';
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { fromIdlJson } from '@squaresdk/solana-sdk';
import type { InstructionCall } from '@squaresdk/solana-types';
import type { SquareChain } from './chain.js';

export class UnsignedTransactionError extends Error {
  constructor(
    message: string,
    readonly signatures: readonly SignatureCheck[],
  ) {
    super(message);
    this.name = 'UnsignedTransactionError';
  }
}

export interface SignatureCheck {
  signer: string;
  status: 'valid' | 'missing' | 'invalid';
}

export interface TxSummary {
  feePayer: string;
  /** Zorunlu imzacılar, mesajdaki sırayla (ilki fee payer). */
  requiredSigners: string[];
  recentBlockhash: string;
  instructions: { program: string; programId: string; accounts: number; dataBytes: number }[];
  addressLookupTables: string[];
  signatures: SignatureCheck[];
}

export function decodeTransaction(base64: string): VersionedTransaction {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== base64.replace(/\s+/g, '')) {
    throw new Error('transaction is not valid base64');
  }
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch (error) {
    throw new Error(`transaction could not be decoded: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ed25519Verify(signer: PublicKey, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, signer.toBuffer()]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, message, key, signature);
}

/** Her zorunlu imzacının imzasını doğrular. */
export function checkSignatures(tx: VersionedTransaction): SignatureCheck[] {
  const { header, staticAccountKeys } = tx.message;
  const message = tx.message.serialize();
  return staticAccountKeys.slice(0, header.numRequiredSignatures).map((signer, index) => {
    const signature = tx.signatures[index];
    if (!signature || signature.every((byte) => byte === 0)) return { signer: signer.toBase58(), status: 'missing' };
    return { signer: signer.toBase58(), status: ed25519Verify(signer, message, signature) ? 'valid' : 'invalid' };
  });
}

export function summarize(tx: VersionedTransaction, programNames: ReadonlyMap<string, string>): TxSummary {
  const { message } = tx;
  const keys = message.staticAccountKeys;
  const required = keys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
  return {
    feePayer: required[0] ?? '',
    requiredSigners: required,
    recentBlockhash: message.recentBlockhash,
    instructions: message.compiledInstructions.map((ix) => {
      const programId = keys[ix.programIdIndex]?.toBase58() ?? `#${ix.programIdIndex}`;
      return {
        program: programNames.get(programId) ?? 'unknown',
        programId,
        accounts: ix.accountKeyIndexes.length,
        dataBytes: ix.data.length,
      };
    }),
    addressLookupTables: message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58()),
    signatures: checkSignatures(tx),
  };
}

/** Özetlerde program adları: Square escrow ve compute budget. */
export function knownPrograms(escrowProgramId: PublicKey): ReadonlyMap<string, string> {
  return new Map([
    [escrowProgramId.toBase58(), 'square_escrow'],
    [ComputeBudgetProgram.programId.toBase58(), 'compute_budget'],
  ]);
}

export interface Submission {
  signature: string;
  status: 'processed' | 'confirmed' | 'finalized' | 'pending';
  err: unknown;
}

/**
 * Tam imzalı tx'i gönderir. Eksik ya da geçersiz imza varsa `UnsignedTransactionError` fırlatır ve
 * `chain.sendRaw` çağrılmaz.
 */
export async function submitSigned(chain: SquareChain, tx: VersionedTransaction): Promise<Submission> {
  const signatures = checkSignatures(tx);
  const bad = signatures.filter((check) => check.status !== 'valid');
  if (bad.length > 0) {
    throw new UnsignedTransactionError(
      `transaction not sent: ${bad.map((check) => `${check.status} signature for ${check.signer}`).join(', ')}`,
      signatures,
    );
  }
  const signature = await chain.sendRaw(tx.serialize());
  const confirmation = await chain.waitForConfirmation(signature);
  return { signature, ...confirmation };
}

/** Açıkça yapılandırılmış yerel keypair (Solana CLI biçimi: 64 baytlık JSON dizi). */
export class LocalSigner {
  private constructor(private readonly keypair: Keypair) {}

  static async fromFile(path: string): Promise<LocalSigner> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new Error(`SQUARE_SIGNER_KEYPAIR okunamadı: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
      throw new Error('SQUARE_SIGNER_KEYPAIR 64 baytlık JSON dizi olmalı (solana-keygen biçimi)');
    }
    return new LocalSigner(Keypair.fromSecretKey(Uint8Array.from(raw as number[])));
  }

  static fromKeypair(keypair: Keypair): LocalSigner {
    return new LocalSigner(keypair);
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  /** Yerel anahtar tx'in zorunlu imzacısı değilse hata; imzalar ve aynı tx'i döner. */
  sign(tx: VersionedTransaction): VersionedTransaction {
    const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (!required.some((key) => key.equals(this.keypair.publicKey))) {
      throw new Error(`local signer ${this.keypair.publicKey.toBase58()} is not a required signer of this transaction`);
    }
    tx.sign([this.keypair]);
    return tx;
  }
}

export interface EncodedCall {
  readonly data: Buffer;
  readonly accounts: readonly string[];
}

interface IdlIx {
  name: string;
  args: { name: string; type: IdlType }[];
  accounts: { name: string }[];
}

export interface CallCoder {
  readonly idl: Idl;
  readonly coder: { readonly instruction: { encode(name: string, data: unknown): Buffer } };
}

export function encodeCall(program: CallCoder, call: InstructionCall): EncodedCall {
  const ix = (program.idl.instructions as unknown as IdlIx[]).find((candidate) => candidate.name === call.instruction);
  if (!ix) throw new Error(`${call.program} programında ${call.instruction} yok`);
  const raw = call.args as Record<string, unknown>;
  const args = Object.fromEntries(
    ix.args.map((arg) => [arg.name, fromIdlJson(program.idl, arg.type, raw[arg.name], `call.args.${arg.name}`)]),
  );
  return { data: program.coder.instruction.encode(ix.name, args), accounts: ix.accounts.map((a) => a.name) };
}

export class PreparedTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreparedTransactionError';
  }
}

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
export const LOCAL_SIGNING_MAX_COMPUTE_UNIT_PRICE = 1_000_000n;

export function verifyPrepared(
  tx: VersionedTransaction,
  expected: {
    programId: PublicKey;
    call: EncodedCall;
    accounts: Readonly<Record<string, string>>;
    computeUnitPrice: bigint | null;
    maxComputeUnitPrice: bigint | null;
  },
): void {
  const { message } = tx;
  const keys = message.staticAccountKeys;
  const fail = (reason: string): never => {
    throw new PreparedTransactionError(`prepared transaction rejected: ${reason}`);
  };
  const budget = new Set<number>();
  let target: { accountKeyIndexes: number[]; data: Uint8Array } | null = null;
  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (program?.equals(ComputeBudgetProgram.programId)) {
      const tag = ix.data[0];
      if ((tag !== SET_COMPUTE_UNIT_LIMIT && tag !== SET_COMPUTE_UNIT_PRICE) || budget.has(tag)) {
        fail('unexpected or repeated compute budget instruction');
      }
      budget.add(tag!);
      if (tag === SET_COMPUTE_UNIT_PRICE) {
        const price = ix.data.length === 9 ? Buffer.from(ix.data).readBigUInt64LE(1) : null;
        if (price === null) fail('malformed compute unit price');
        if (expected.computeUnitPrice !== null && price !== expected.computeUnitPrice) {
          fail('compute unit price differs from the request');
        }
        if (expected.computeUnitPrice === null && expected.maxComputeUnitPrice !== null) {
          if (price! > expected.maxComputeUnitPrice) fail('compute unit price is above the local signing ceiling');
        }
      }
      continue;
    }
    if (!program?.equals(expected.programId)) fail(`instruction for another program (${program?.toBase58() ?? '?'})`);
    if (target) fail('more than one Square instruction');
    target = ix;
  }
  if (!target) return fail('no Square instruction');
  if (!Buffer.from(target.data).equals(expected.call.data)) fail('instruction data differs from the request');
  for (const [name, value] of Object.entries(expected.accounts)) {
    const position = expected.call.accounts.indexOf(name);
    if (position < 0) fail(`unknown account ${name}`);
    const index = target.accountKeyIndexes[position];
    if (index === undefined || index >= keys.length || keys[index]!.toBase58() !== value) {
      fail(`account ${name} differs from the request`);
    }
  }
}
