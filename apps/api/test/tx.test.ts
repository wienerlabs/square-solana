// `POST /v1/tx`: imzasız v0 tx. Argümanlar IDL JSON'undan, PDA'lar sunucuda (gerekirse zincirdeki hesaptan)
// çözülür; compute bütçesi profilden ya da ölçümden; tx simüle edilir.
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type MessageCompiledInstruction,
} from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import type { TxRequest } from '@squaresdk/solana-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { apiKey, login } from './fixtures/login.js';
import { PROGRAM_IDS, PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { World, wallet } from './fixtures/world.js';

let stack: Stack;
let world: World;
let session: string;
const payer = wallet();
const owner = wallet();
const HASH = 'ab'.repeat(32);

beforeAll(async () => {
  stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
  world = new World(stack.db, stack.rpc, stack.client);
  await truncate(stack.db);
  session = await login(stack.api(), owner);
});
afterAll(() => stack.close());
beforeEach(() => stack.rpc.reset());

const registerAgent = (overrides: Partial<TxRequest> = {}): TxRequest => ({
  call: {
    program: 'registry',
    instruction: 'registerAgent',
    args: { agentId: 'research-1', agentCardUri: `${PUBLIC_BASE_URL}/a/x`, agentCardHash: HASH, wallet: owner.address },
  },
  accounts: { payer: payer.address, owner: owner.address },
  feePayer: payer.address,
  computeUnitPrice: null,
  ...overrides,
});

function decode(base64: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  const keys = tx.message.staticAccountKeys;
  const programOf = (ix: MessageCompiledInstruction) => keys[ix.programIdIndex]!;
  const budget = tx.message.compiledInstructions.filter((ix) => programOf(ix).equals(ComputeBudgetProgram.programId));
  const limit = budget.find((ix) => ix.data[0] === 2)!;
  const price = budget.find((ix) => ix.data[0] === 3)!;
  const program = tx.message.compiledInstructions.find((ix) => !programOf(ix).equals(ComputeBudgetProgram.programId))!;
  return {
    tx,
    programId: programOf(program),
    accounts: program.accountKeyIndexes.map((index) => keys[index]?.toBase58()),
    limit: Buffer.from(limit.data).readUInt32LE(1),
    price: Buffer.from(price.data).readBigUInt64LE(1),
  };
}

describe('tx hazırlama', () => {
  it('profilli talimat: PDA sunucuda çözülür, profil sınırı ve sunucu fiyatı, simülasyon birimleri', async () => {
    const response = await stack.api({ session }).prepareTx(registerAgent());
    if (!response.success) throw new Error(JSON.stringify(response.error));
    const [agentRecord] = stack.client.pda.agentRecord(owner.keypair.publicKey, 'research-1');
    const tx = decode(response.data.transaction);
    expect(tx.programId.equals(PROGRAM_IDS.registry)).toBe(true);
    expect(tx.accounts).toEqual([
      payer.address,
      owner.address,
      agentRecord.toBase58(),
      SystemProgram.programId.toBase58(),
    ]);
    expect(tx.limit).toBe(40_000);
    expect(tx.price).toBe(1_000n);
    expect(response.data).toMatchObject({
      blockhash: stack.rpc.blockhash,
      feePayer: payer.address,
      signers: [payer.address, owner.address],
      addressLookupTables: [],
      computeUnitLimit: 40_000,
      simulatedUnits: 12_345,
    });
    expect(tx.tx.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    expect(stack.rpc.simulated).toHaveLength(1);
    const priced = await stack.api({ session }).prepareTx(registerAgent({ computeUnitPrice: '5000' }));
    expect(decode(priced.data!.transaction).price).toBe(5_000n);
  });

  it('profilde olmayan talimatın sınırı ölçümün iki katıdır (10 bine yukarı)', async () => {
    stack.rpc.simulations.push({ err: null, logs: [], unitsConsumed: 4_321 });
    const agentRecord = await world.agent(owner.address, owner.address);
    const response = await stack.api({ session }).prepareTx({
      call: { program: 'registry', instruction: 'setAgentStatus', args: { status: 'inactive' } },
      accounts: { owner: owner.address, agentRecord },
      feePayer: owner.address,
      computeUnitPrice: '0',
    });
    if (!response.success) throw new Error(JSON.stringify(response.error));
    expect(response.data.computeUnitLimit).toBe(10_000);
    expect(decode(response.data.transaction).limit).toBe(10_000);
    expect(stack.rpc.simulated).toHaveLength(2);
  });

  it('çözücü zincirdeki hesabı okur (job → agentRecord); eksik hesap 400', async () => {
    const agent = wallet();
    const agentRecord = await world.agent(owner.address, agent.address);
    const job = await world.job({ institution: owner.address, agentRecord, agentWallet: agent.address });
    const api = stack.api({ session });
    const request: TxRequest = {
      call: { program: 'escrow', instruction: 'acceptJob', args: { specHash: job.specHash } },
      accounts: { agent: agent.address, job: job.address },
      feePayer: agent.address,
      computeUnitPrice: null,
    };
    const response = await api.prepareTx(request);
    if (!response.success) throw new Error(JSON.stringify(response.error));
    expect(decode(response.data.transaction).accounts).toEqual([agent.address, job.address, agentRecord]);
    expect(response.data.computeUnitLimit).toBe(20_000);
    const missing = await api.prepareTx({ ...request, accounts: { agent: agent.address } });
    expect(missing).toMatchObject({ error: { code: 'invalid_input', message: expect.stringContaining('çözülemedi') } });
    const absent = await api.prepareTx({ ...request, accounts: { agent: agent.address, job: wallet().address } });
    expect(absent).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('geçersiz argüman ve hesap adı 400; simülasyon hatası 422 programError ile', async () => {
    const api = stack.api({ session });
    const badArg = await api.prepareTx(
      registerAgent({
        call: {
          program: 'registry',
          instruction: 'registerAgent',
          args: { agentId: 'x', agentCardUri: 'u', agentCardHash: 'abcd', wallet: owner.address },
        },
      }),
    );
    expect(badArg).toMatchObject({ error: { code: 'invalid_input' } });
    const unknownAccount = await api.prepareTx(
      registerAgent({ accounts: { payer: payer.address, owner: owner.address, extra: owner.address } }),
    );
    expect(unknownAccount).toMatchObject({
      error: { code: 'invalid_input', message: expect.stringContaining('extra') },
    });
    const notCall = await api.prepareTx({
      ...registerAgent(),
      call: { program: 'registry', instruction: 'nope', args: {} },
    } as never);
    expect(notCall).toMatchObject({ error: { code: 'invalid_input' } });

    const registry = PROGRAM_IDS.registry.toBase58();
    stack.rpc.simulations.push({
      err: { InstructionError: [2, { Custom: 6000 }] },
      logs: [`Program ${registry} invoke [1]`, `Program ${registry} failed: custom program error: 0x1770`],
      unitsConsumed: 900,
    });
    const failed = await api.prepareTx(registerAgent());
    const expected = (SQUARE_IDLS.registry.errors as readonly { code: number; name: string }[]).find(
      (e) => e.code === 6000,
    )!;
    expect(failed).toMatchObject({
      success: false,
      error: {
        code: 'simulation_failed',
        programError: { program: 'registry', code: 6000, name: expected.name },
        details: { err: { InstructionError: [2, { Custom: 6000 }] } },
      },
    });
    stack.rpc.simulations.push({ err: 'AccountNotFound', logs: [], unitsConsumed: 0 });
    expect(await api.prepareTx(registerAgent())).toMatchObject({
      error: { code: 'simulation_failed', programError: null, details: { err: 'AccountNotFound' } },
    });
  });

  it('yetki: oturum ya da tx:prepare kapsamlı anahtar; RPC düşerse 503', async () => {
    expect(await stack.api().prepareTx(registerAgent())).toMatchObject({ error: { code: 'unauthorized' } });
    const readOnly = await apiKey(stack, owner, ['read']);
    expect(await stack.api({ apiKey: readOnly }).prepareTx(registerAgent())).toMatchObject({
      error: { code: 'forbidden' },
    });
    const prepare = await apiKey(stack, owner, ['tx:prepare']);
    expect((await stack.api({ apiKey: prepare }).prepareTx(registerAgent())).success).toBe(true);
    stack.rpc.failWith = 500;
    expect(await stack.api({ apiKey: prepare }).prepareTx(registerAgent())).toMatchObject({
      error: { code: 'rpc_unavailable' },
    });
  });
});

describe('Square ALT', () => {
  it('yapılandırılmış lookup table her tx’e eklenir', async () => {
    const table = wallet().keypair.publicKey;
    const withTable = await startStack({
      openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
      lookupTable: table,
    });
    try {
      // AddressLookupTable durumu: tip 1, devre dışı slot u64 max, son genişletme, yetkili yok, adresler 56. bayttan.
      const meta = Buffer.alloc(56);
      meta.writeUInt32LE(1, 0);
      meta.writeBigUInt64LE(0xffffffffffffffffn, 4);
      const addresses = [SystemProgram.programId, PROGRAM_IDS.registry].map((key) => key.toBuffer());
      withTable.rpc.setAccount(table.toBase58(), {
        owner: AddressLookupTableProgram.programId.toBase58(),
        data: Buffer.concat([meta, ...addresses]),
      });
      const token = await login(withTable.api(), owner);
      const response = await withTable.api({ session: token }).prepareTx(registerAgent());
      if (!response.success) throw new Error(JSON.stringify(response.error));
      expect(response.data.addressLookupTables).toEqual([table.toBase58()]);
      const message = VersionedTransaction.deserialize(Buffer.from(response.data.transaction, 'base64')).message;
      expect(message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58())).toEqual([table.toBase58()]);
      expect(message.staticAccountKeys.some((key) => key.equals(SystemProgram.programId))).toBe(false);
      const unknown = new PublicKey(wallet().address);
      expect(unknown.toBase58()).not.toBe(table.toBase58());
    } finally {
      await withTable.close();
    }
  });
});
