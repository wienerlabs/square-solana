// CCTP uçları (BE-26): burn kaydı, transfer okuma ve kurumun imzalayacağı tx. Zincir fixture RPC'dedir (escrow
// config'i, USDC, Circle'ın `TokenMessenger` hesabı, iki ALT, job); mesaj BC-36 devnet koşusunun gerçek
// attestation'lı mesajıdır, mint alıcısı bu testin kurumuna çevrilmiştir. Relayer'ın yazdığı attestation alanları
// depoya doğrudan yazılır (relayer packages/cctp'de test edilir).
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createTransferStore } from '@squaresdk/solana-cctp';
import {
  CCTP_RECEIVE_COMPUTE_UNITS,
  cctpLookupTableAddresses,
  cctpMintRecipient,
  cctpUsedNonceAddress,
  decodeCctpMessage,
  squareLookupTableAddresses,
  TX_COMPUTE_UNIT_LIMITS,
} from '@squaresdk/solana-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { apiKey, login } from './fixtures/login.js';
import { PROGRAM_IDS, PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { sample } from './fixtures/sample.js';
import { World, wallet } from './fixtures/world.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../packages/sdk/test/fixtures/cctp-sepolia-to-solana.json', import.meta.url), 'utf8'),
) as { message: string; attestation: string };
const CCTP_PROGRAMS = {
  messageTransmitter: new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC'),
  tokenMessengerMinter: new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe'),
};
const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const FEE_RECIPIENT = new PublicKey('AYG63YgrKLbp9B23ntcRemU8kSD7rZ7cNFGDo8DbEfTd');
const SEPOLIA_USDC = Buffer.concat([Buffer.alloc(12), Buffer.from('1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'hex')]);
const squareTable = wallet().keypair.publicKey;
const cctpTable = wallet().keypair.publicKey;

let stack: Stack;
let world: World;
const institution = wallet();
const recipient = cctpMintRecipient(institution.keypair.publicKey, USDC);
/** Gerçek mesaj, mint alıcısı bu testin kurumunun USDC hesabı. */
const message = (() => {
  const bytes = Buffer.from(fixture.message.slice(2), 'hex');
  recipient.toBuffer().copy(bytes, 148 + 36);
  return bytes;
})();
const usedNonce = cctpUsedNonceAddress(CCTP_PROGRAMS, decodeCctpMessage(message).nonce);
const txHash = () => `0x${randomBytes(32).toString('hex')}`;

/** AddressLookupTable durumu: tip 1, devre dışı slot u64 max, yetkili yok, adresler 56. bayttan. */
function lookupTable(address: PublicKey, entries: PublicKey[]) {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0);
  meta.writeBigUInt64LE(0xffffffffffffffffn, 4);
  stack.rpc.setAccount(address.toBase58(), {
    owner: AddressLookupTableProgram.programId.toBase58(),
    data: Buffer.concat([meta, ...entries.map((key) => key.toBuffer())]),
  });
}

async function chain() {
  const escrow = world.programs.escrow;
  await world.onChain(
    'escrow',
    'escrowConfig',
    stack.client.pda.escrowConfig()[0],
    sample(escrow.idl, 'escrowConfig', { settlementMint: USDC }),
  );
  stack.rpc.setAccount(USDC.toBase58(), { owner: TOKEN_PROGRAM_ID.toBase58(), data: Buffer.alloc(82) });
  stack.rpc.setAccount(recipient.toBase58(), { owner: TOKEN_PROGRAM_ID.toBase58(), data: Buffer.alloc(165) });
  const messenger = Buffer.alloc(141);
  FEE_RECIPIENT.toBuffer().copy(messenger, 109);
  stack.rpc.setAccount(
    PublicKey.findProgramAddressSync(
      [Buffer.from('token_messenger')],
      CCTP_PROGRAMS.tokenMessengerMinter,
    )[0].toBase58(),
    { owner: CCTP_PROGRAMS.tokenMessengerMinter.toBase58(), data: messenger },
  );
  lookupTable(
    squareTable,
    squareLookupTableAddresses({ programIds: PROGRAM_IDS, pda: stack.client.pda, settlementMint: USDC }),
  );
  lookupTable(
    cctpTable,
    cctpLookupTableAddresses({
      programs: CCTP_PROGRAMS,
      usdcMint: USDC,
      sourceDomain: 0,
      burnToken: SEPOLIA_USDC,
      feeRecipient: FEE_RECIPIENT,
      tokenProgram: TOKEN_PROGRAM_ID,
    }),
  );
}

async function job(overrides: { status?: string; institution?: PublicKey } = {}) {
  const address = wallet().keypair.publicKey;
  await world.onChain(
    'escrow',
    'job',
    address,
    sample(world.programs.escrow.idl, 'job', {
      institution: overrides.institution ?? institution.keypair.publicKey,
      mint: USDC,
      status: { [overrides.status ?? 'open']: {} },
      policy: null,
    }),
  );
  return address.toBase58();
}

beforeAll(async () => {
  stack = await startStack({
    openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
    lookupTable: squareTable,
    cctp: { programs: CCTP_PROGRAMS, lookupTables: new Map([[0, cctpTable]]) },
  });
  world = new World(stack.db, stack.rpc, stack.client);
  await truncate(stack.db);
});
afterAll(() => stack.close());
beforeEach(async () => {
  stack.rpc.reset();
  // Testler aynı mesajı (aynı nonce) kullanır; nonce kaynak domain başına tekildir.
  await stack.db.cctpTransfer.deleteMany();
  await chain();
});

describe('kayıt', () => {
  it('job’un kurumu kaydeder (201), yeniden kayıt aynı transferi döner (200), başka job 409', async () => {
    const session = await login(stack.api(), institution);
    const api = stack.api({ session });
    const hash = txHash();
    const target = await job();
    const created = await api.registerCctpTransfer({
      sourceDomain: 0,
      sourceTxHash: hash.toUpperCase().replace('0X', '0x'),
      job: target,
    });
    if (!created.success) throw new Error(JSON.stringify(created.error));
    expect(created.data).toMatchObject({
      sourceTxHash: hash,
      job: target,
      institution: institution.address,
      mintRecipient: recipient.toBase58(),
      status: 'pendingAttestation',
      nonce: null,
      minted: null,
    });
    const raw = await fetch(`${stack.url}/v1/cctp/transfers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceDomain: 0, sourceTxHash: hash, job: target }),
    });
    expect(raw.status).toBe(200);
    expect(((await raw.json()) as { data: { id: string } }).data.id).toBe(created.data.id);
    const other = await api.registerCctpTransfer({ sourceDomain: 0, sourceTxHash: hash, job: await job() });
    expect(other).toMatchObject({ success: false, error: { code: 'conflict' } });
  });

  it('yetki ve girdi: kimliksiz 401, read anahtarı 403, başka kurum 403, desteklenmeyen kaynak 400, bozuk hash 400', async () => {
    const target = await job();
    const body = { sourceDomain: 0, sourceTxHash: txHash(), job: target };
    expect(await stack.api().registerCctpTransfer(body)).toMatchObject({ error: { code: 'unauthorized' } });
    const reader = await apiKey(stack, institution, ['read']);
    expect(await stack.api({ apiKey: reader }).registerCctpTransfer(body)).toMatchObject({
      error: { code: 'forbidden' },
    });
    const stranger = stack.api({ session: await login(stack.api(), wallet()) });
    expect(await stranger.registerCctpTransfer(body)).toMatchObject({ error: { code: 'forbidden' } });
    const api = stack.api({ session: await login(stack.api(), institution) });
    expect(await api.registerCctpTransfer({ ...body, sourceDomain: 6 })).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(await api.registerCctpTransfer({ ...body, sourceTxHash: '0x12' })).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(await api.registerCctpTransfer({ ...body, job: await job({ status: 'funded' }) })).toMatchObject({
      error: { code: 'conflict' },
    });
    expect(await api.registerCctpTransfer({ ...body, job: wallet().address })).toMatchObject({
      error: { code: 'not_found' },
    });
    // tx:prepare kapsamlı anahtar kurum adına kaydedebilir.
    const writer = await apiKey(stack, institution, ['tx:prepare']);
    expect(await stack.api({ apiKey: writer }).registerCctpTransfer(body)).toMatchObject({ success: true });
  });
});

describe('okuma', () => {
  it('liste süzgeçli ve sayfalı, tek transfer; bilinmeyen 404, bozuk kimlik 400', async () => {
    const api = stack.api({ session: await login(stack.api(), institution) });
    const target = await job();
    const first = await api.registerCctpTransfer({ sourceDomain: 0, sourceTxHash: txHash(), job: target });
    if (!first.success) throw new Error(JSON.stringify(first.error));
    const list = await stack.api().listCctpTransfers({ job: target, status: 'pendingAttestation' });
    expect(list).toMatchObject({ success: true, meta: { total: 1 } });
    expect(await stack.api().getCctpTransfer(first.data.id)).toMatchObject({ data: { id: first.data.id } });
    expect(await stack.api().getCctpTransfer('00000000-0000-4000-8000-000000000000')).toMatchObject({
      error: { code: 'not_found' },
    });
    expect(await stack.api().getCctpTransfer('x')).toMatchObject({ error: { code: 'invalid_input' } });
    expect(await stack.api().listCctpTransfers({ status: 'nope' as never })).toMatchObject({
      error: { code: 'invalid_input' },
    });
  });
});

describe('kurumun fonlama tx’i', () => {
  async function attested() {
    const api = stack.api({ session: await login(stack.api(), institution) });
    const target = await job();
    const created = await api.registerCctpTransfer({ sourceDomain: 0, sourceTxHash: txHash(), job: target });
    if (!created.success) throw new Error(JSON.stringify(created.error));
    return { api, target, id: created.data.id };
  }

  const markAttested = (id: string) =>
    createTransferStore(stack.db).update(id, {
      status: 'attested',
      nonce: Buffer.from(decodeCctpMessage(message).nonce).toString('hex'),
      message: message.toString('hex'),
      attestation: fixture.attestation.slice(2),
      amount: 5_000_000n,
      feeExecuted: 0n,
      attestedAt: new Date(),
    });

  it('attestation yokken 409; gelince mint + fonlama tek tx’te (iki ALT), teslim edildiyse yalnızca fonlama', async () => {
    const { api, id } = await attested();
    const request = { feePayer: institution.address, computeUnitPrice: null };
    expect(await api.prepareCctpFundTx(id, request)).toMatchObject({ error: { code: 'conflict' } });
    await markAttested(id);

    const combined = await api.prepareCctpFundTx(id, request);
    if (!combined.success) throw new Error(JSON.stringify(combined.error));
    expect(combined.data).toMatchObject({
      step: 'receiveAndFund',
      transfer: { id, status: 'attested', minted: '5000000' },
      tx: {
        feePayer: institution.address,
        signers: [institution.address],
        addressLookupTables: [squareTable.toBase58(), cctpTable.toBase58()],
        simulatedUnits: 12_345,
      },
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(combined.data.tx.transaction, 'base64'));
    expect(tx.message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58())).toEqual([
      squareTable.toBase58(),
      cctpTable.toBase58(),
    ]);
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
    const keys = tx.message.staticAccountKeys;
    expect(
      tx.message.compiledInstructions.some(
        (ix) => keys[ix.programIdIndex]?.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2,
      ),
    ).toBe(true);
    expect(combined.data.tx.computeUnitLimit).toBe(TX_COMPUTE_UNIT_LIMITS.fundJob + CCTP_RECEIVE_COMPUTE_UNITS);

    stack.rpc.setAccount(usedNonce.toBase58(), {
      owner: CCTP_PROGRAMS.messageTransmitter.toBase58(),
      data: Buffer.alloc(0),
    });
    const fundOnly = await api.prepareCctpFundTx(id, request);
    expect(fundOnly).toMatchObject({
      success: true,
      data: { step: 'fund', tx: { addressLookupTables: [squareTable.toBase58()] } },
    });
  });

  it('zincirde düşecek tx 422, başka kurum 403, bilinmeyen 404', async () => {
    const { api, id } = await attested();
    await markAttested(id);
    stack.rpc.simulations.push({
      err: { InstructionError: [2, { Custom: 6012 }] },
      logs: ['Program log: AnchorError occurred. Error Code: ScreeningNotClear. Error Number: 6012.'],
      unitsConsumed: 100,
    });
    const request = { feePayer: institution.address, computeUnitPrice: '5' };
    expect(await api.prepareCctpFundTx(id, request)).toMatchObject({ error: { code: 'simulation_failed' } });
    const stranger = stack.api({ session: await login(stack.api(), wallet()) });
    expect(await stranger.prepareCctpFundTx(id, request)).toMatchObject({ error: { code: 'forbidden' } });
    expect(await api.prepareCctpFundTx('00000000-0000-4000-8000-000000000000', request)).toMatchObject({
      error: { code: 'not_found' },
    });
  });
});

describe('yapılandırılmamış API', () => {
  it('kaydı ve tx’i reddeder, okuma çalışır', async () => {
    const plain = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
    try {
      const api = plain.api({ session: await login(plain.api(), institution) });
      expect(
        await api.registerCctpTransfer({ sourceDomain: 0, sourceTxHash: txHash(), job: wallet().address }),
      ).toMatchObject({
        error: { code: 'invalid_input', message: expect.stringMatching(/yapılandırılmamış/) },
      });
      expect(
        await api.prepareCctpFundTx('00000000-0000-4000-8000-000000000000', {
          feePayer: institution.address,
          computeUnitPrice: null,
        }),
      ).toMatchObject({ error: { code: 'invalid_input' } });
      expect(await plain.api().listCctpTransfers()).toMatchObject({ success: true });
    } finally {
      await plain.close();
    }
  });
});
