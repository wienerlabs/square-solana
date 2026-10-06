// `POST /v1/tx`: tek instruction için imzasız v0 tx (api-sdk-contract §5). Argümanlar IDL JSON'undan Anchor
// değerine çevrilir (`fromIdlJson`); PDA'lar ve IDL'deki sabit adresler Anchor'ın çözücüsüyle sunucuda bulunur,
// istek yalnızca türetilemeyen hesapları taşır. Compute unit sınırı BC-28 profilindendir; profilde olmayan
// talimatta tx bir kez simüle edilir ve sınır profilin yöntemiyle (ölçümün iki katı, 10 bine yukarı) konur.
// Tx her durumda simüle edilir: zincirde düşecek bir tx imzaya gönderilmez, hata `simulation_failed` +
// `programError` ile döner.
import type { Idl, Program } from '@anchor-lang/core';
import {
  IdlJsonError,
  MAX_COMPUTE_UNIT_LIMIT,
  SQUARE_IDLS,
  TX_COMPUTE_UNIT_LIMITS,
  fromIdlJson,
  type BuiltTx,
  type SquareClient,
  type SquareProgramName,
  type TxKind,
} from '@squaresdk/solana-sdk';
import type { ProgramErrorRef, TxRequest, UnsignedTx } from '@squaresdk/solana-types';
import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { HttpError, badRequest } from './http.js';

/** Profil yöntemi: ölçülen birimin iki katı, 10 bine yukarı yuvarlanmış (tx-profile.json). */
const MEASURED_MULTIPLIER = 2;
const LIMIT_STEP = 10_000;

export interface TxBuilder {
  prepare(request: TxRequest): Promise<UnsignedTx>;
}

interface Simulation {
  readonly err: unknown;
  readonly logs: readonly string[] | null;
  readonly unitsConsumed: number | null;
}

const rpcUnavailable = (error: unknown) =>
  new HttpError(503, 'rpc_unavailable', 'Solana RPC yanıt vermedi', null, null, error);

/** Simülasyon hatasının JSON'u (`InstructionError` gibi iç içe yapılar; bigint içermez). */
const jsonSafe = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));

export function createTxBuilder(deps: {
  client: SquareClient;
  connection: Connection;
  lookupTable: PublicKey | null;
  computeUnitPrice: bigint;
}): TxBuilder {
  const { client, connection } = deps;
  const programs = {
    registry: client.registry.program,
    policy: client.policy.program,
    verifier: client.verifier.program,
    escrow: client.escrow.program,
  } as unknown as Record<SquareProgramName, Program<Idl>>;

  async function instruction(request: TxRequest): Promise<TransactionInstruction> {
    const program = programs[request.call.program];
    const ix = program.idl.instructions.find((candidate) => candidate.name === request.call.instruction);
    if (!ix) throw badRequest(`${request.call.program} programında ${request.call.instruction} yok`);
    const raw = request.call.args as Record<string, unknown>;
    let args: unknown[];
    try {
      args = ix.args.map((arg) => fromIdlJson(program.idl, arg.type, raw[arg.name], `call.args.${arg.name}`));
    } catch (error) {
      if (error instanceof IdlJsonError) throw badRequest(error.message, { path: error.path });
      throw error;
    }
    const names = new Set(ix.accounts.map((account) => account.name));
    const unknown = Object.keys(request.accounts).filter((name) => !names.has(name));
    if (unknown.length > 0) throw badRequest(`${ix.name} talimatında olmayan hesap: ${unknown.join(', ')}`);
    const accounts = Object.fromEntries(
      Object.entries(request.accounts).map(([name, address]) => [name, new PublicKey(address)]),
    );
    const methods = program.methods as Record<
      string,
      (...values: unknown[]) => { accountsPartial(a: unknown): { instruction(): Promise<TransactionInstruction> } }
    >;
    try {
      return await methods[ix.name]!(...args)
        .accountsPartial(accounts)
        .instruction();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Çözülemeyen hesap (istekte eksik) ya da çözücünün okuduğu hesap zincirde yok: istemcinin girdisi.
      if (/Unresolved (accounts|PDAs)|must be provided|Account does not exist/.test(message)) {
        throw badRequest(`hesaplar çözülemedi: ${message}`);
      }
      // Çözücünün hesap okuması RPC'de düştü.
      if (/failed to get (info about account|multiple accounts)/.test(message)) throw rpcUnavailable(error);
      throw error;
    }
  }

  async function build(ix: TransactionInstruction, request: TxRequest, computeUnitLimit: number | undefined) {
    try {
      return await client.buildTx([ix], {
        feePayer: new PublicKey(request.feePayer),
        computeUnitPrice: request.computeUnitPrice === null ? deps.computeUnitPrice : BigInt(request.computeUnitPrice),
        ...(computeUnitLimit === undefined ? {} : { computeUnitLimit }),
        addressLookupTables: deps.lookupTable ? [deps.lookupTable] : [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/paket sınırını/.test(message)) throw badRequest(message);
      throw rpcUnavailable(error);
    }
  }

  async function simulate(built: BuiltTx): Promise<Simulation> {
    try {
      const { value } = await connection.simulateTransaction(built.transaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      return { err: value.err, logs: value.logs ?? null, unitsConsumed: value.unitsConsumed ?? null };
    } catch (error) {
      throw rpcUnavailable(error);
    }
  }

  /** Program hatası; ad sözleşmedeki IDL adıdır (`IDL_PROGRAMS[program].errors`), Anchor'ın camelCase IDL'inden gelmez. */
  function programErrorOf(logs: readonly string[]): ProgramErrorRef | null {
    let mapped: ProgramErrorRef | null;
    try {
      mapped = client.mapError({ logs });
    } catch {
      // Logda ve IDL'de olmayan kod: hata yine simülasyon hatası olarak döner.
      return null;
    }
    if (!mapped) return null;
    const errors = SQUARE_IDLS[mapped.program].errors as readonly { code: number; name: string }[];
    return { ...mapped, name: errors.find((error) => error.code === mapped.code)?.name ?? mapped.name };
  }

  function failure(simulation: Simulation): HttpError {
    const programError = programErrorOf(simulation.logs ?? []);
    return new HttpError(
      422,
      'simulation_failed',
      programError ? `${programError.program} ${programError.name} (${programError.code})` : 'tx simülasyonu başarısız',
      { err: jsonSafe(simulation.err) as Record<string, unknown> | string | null },
      programError,
    );
  }

  return {
    async prepare(request) {
      const ix = await instruction(request);
      const kind = request.call.instruction as TxKind;
      let limit: number | undefined = Object.hasOwn(TX_COMPUTE_UNIT_LIMITS, kind)
        ? TX_COMPUTE_UNIT_LIMITS[kind]
        : undefined;
      if (limit === undefined) {
        const measured = await simulate(await build(ix, request, undefined));
        if (measured.err !== null) throw failure(measured);
        const units = measured.unitsConsumed ?? MAX_COMPUTE_UNIT_LIMIT;
        limit = Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.ceil((units * MEASURED_MULTIPLIER) / LIMIT_STEP) * LIMIT_STEP);
      }
      const built = await build(ix, request, limit);
      const simulation = await simulate(built);
      if (simulation.err !== null) throw failure(simulation);
      return {
        transaction: Buffer.from(built.transaction.serialize()).toString('base64'),
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
        feePayer: request.feePayer,
        signers: built.signers.map((signer) => signer.toBase58()),
        addressLookupTables: deps.lookupTable ? [deps.lookupTable.toBase58()] : [],
        computeUnitLimit: limit,
        simulatedUnits: simulation.unitsConsumed,
      };
    },
  };
}
