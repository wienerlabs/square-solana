import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionExpiredBlockheightExceededError,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createSquareClient, type BuiltTx } from '@squaresdk/solana-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  chainTime,
  clockUnixTimestamp,
  computeUnitLimitOf,
  createSender,
  isLandedTransactionError,
  executableHash,
  MAX_SEND_ATTEMPTS,
  parseProgramData,
  programDataAddress,
  squadsVault,
  txRecordOf,
  waitForChainTime,
  waitForFinalizedSlotAfter,
  type ConfirmedTxMeta,
} from '../src/chain.js';
import { IDS } from './helpers.js';

const programIds = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [k, new PublicKey(v)])) as never;
const client = createSquareClient({
  connection: new Connection('http://127.0.0.1:1'),
  programIds,
  commitment: 'confirmed',
});

const payer = Keypair.generate();
const blockhash = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toBase58();

function built(limit?: number): BuiltTx {
  const instructions = [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
  ];
  if (limit !== undefined) instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: limit }));
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return {
    transaction: new VersionedTransaction(message),
    signers: [payer.publicKey],
    blockhash,
    lastValidBlockHeight: 10,
  };
}

const escrowFailure = (code: number) => [
  `Program ${IDS.escrow} invoke [1]`,
  `Program ${IDS.escrow} failed: custom program error: 0x${code.toString(16)}`,
];
const confirmed = (meta: Partial<NonNullable<ConfirmedTxMeta['meta']>> | null): ConfirmedTxMeta => ({
  slot: 42,
  meta: meta && { fee: 5_000, computeUnitsConsumed: 1_234, err: null, logMessages: [], ...meta },
});

describe('tx kaydı', () => {
  it('CU sınırını mesajdan okur; yoksa null', () => {
    expect(computeUnitLimitOf(built(200_000).transaction.message)).toBe(200_000);
    expect(computeUnitLimitOf(built().transaction.message)).toBeNull();
  });

  it('başarılı ve beklenen ret kayıtları; eşlenemeyen hata ve eksik meta fırlatır', () => {
    const base = {
      step: '1',
      label: 'x',
      signature: 'sig',
      transaction: built(1_000).transaction,
      mapError: client.mapError,
    };
    const ok = txRecordOf({ ...base, confirmed: confirmed({}) });
    expect(ok).toMatchObject({
      slot: 42,
      computeUnits: 1_234,
      computeUnitLimit: 1_000,
      feeLamports: 5_000,
      error: null,
    });
    expect(ok.sizeBytes).toBe(base.transaction.serialize().length);
    const refused = txRecordOf({
      ...base,
      confirmed: confirmed({ err: { InstructionError: [0, { Custom: 6039 }] }, logMessages: escrowFailure(6039) }),
    });
    expect(refused.error).toEqual({ program: 'escrow', code: 6039, name: 'proofRequired' });
    expect(() => txRecordOf({ ...base, confirmed: confirmed({ err: 'AccountInUse', logMessages: [] }) })).toThrow(
      /program hatası değil/,
    );
    expect(() => txRecordOf({ ...base, confirmed: confirmed(null) })).toThrow(/meta/);
    expect(() => txRecordOf({ ...base, confirmed: confirmed({ computeUnitsConsumed: undefined }) })).toThrow(
      /computeUnitsConsumed/,
    );
  });
});

/** Gönderimi taklit eden bağlantı: ilk `expireTimes` onay blockhash süresi dolarak düşer. */
function fakeConnection(options: {
  expireTimes?: number;
  meta?: Partial<NonNullable<ConfirmedTxMeta['meta']>>;
  sendError?: unknown;
  /** Onay, imza durumunu yoklayan yoldaki gibi zincir hatasıyla reddedilir. */
  confirmError?: unknown;
}) {
  let expired = 0;
  let lookups = 0;
  const sent: { skipPreflight?: boolean }[] = [];
  const connection = {
    async sendRawTransaction(_raw: Uint8Array, opts: { skipPreflight?: boolean }) {
      if (options.sendError) throw options.sendError;
      sent.push(opts);
      return `sig-${sent.length}`;
    },
    async confirmTransaction() {
      if (expired < (options.expireTimes ?? 0)) {
        expired += 1;
        throw new TransactionExpiredBlockheightExceededError('sig');
      }
      if (options.confirmError !== undefined) throw options.confirmError;
      return { value: { err: null } };
    },
    async getTransaction() {
      lookups += 1;
      return lookups === 1 ? null : confirmed(options.meta ?? {});
    },
  } as unknown as Connection;
  return { connection, sent };
}

describe('createSender', () => {
  it('blockhash dolarsa tx yeniden kurulur; kayıt tutulur ve günlüğe yazılır', async () => {
    const { connection, sent } = fakeConnection({ expireTimes: 1 });
    const lines: string[] = [];
    const sender = createSender(connection, client, (line) => lines.push(line));
    const build = vi.fn(async () => built(1_000));
    const record = await sender.send('3', '`fundJob`', build, [payer]);
    expect(build).toHaveBeenCalledTimes(2);
    expect(record.signature).toBe('sig-2');
    expect(sent.every((o) => o.skipPreflight === false)).toBe(true);
    expect(sender.records).toEqual([record]);
    expect(lines.join('\n')).toMatch(/yeniden kuruluyor \(1\/3\)[\s\S]*sig-2 · 1234 CU · 5000 lamport/);
  });

  it(`en fazla ${MAX_SEND_ATTEMPTS} deneme`, async () => {
    const { connection } = fakeConnection({ expireTimes: MAX_SEND_ATTEMPTS });
    const sender = createSender(connection, client, () => {});
    await expect(sender.send('3', 'x', async () => built(), [payer])).rejects.toBeInstanceOf(
      TransactionExpiredBlockheightExceededError,
    );
  });

  it('beklenen ret ön simülasyonsuz gönderilir; başka sonuç hata', async () => {
    const failing = fakeConnection({ meta: { err: { Custom: 6039 }, logMessages: escrowFailure(6039) } });
    const sender = createSender(failing.connection, client, () => {});
    const record = await sender.send('6 + 8', 'finalize', async () => built(), [payer], 'proofRequired');
    expect(record.error?.name).toBe('proofRequired');
    expect(failing.sent[0]!.skipPreflight).toBe(true);
    await expect(sender.send('6 + 8', 'finalize', async () => built(), [payer])).rejects.toThrow(
      /escrow proofRequired/,
    );
    const other = createSender(
      fakeConnection({ meta: { err: { Custom: 6008 }, logMessages: escrowFailure(6008) } }).connection,
      client,
      () => {},
    );
    await expect(other.send('6 + 8', 'finalize', async () => built(), [payer], 'proofRequired')).rejects.toThrow(
      /proofRequired bekleniyordu, challengePeriodNotExpired/,
    );
    const success = createSender(fakeConnection({}).connection, client, () => {});
    await expect(success.send('6 + 8', 'finalize', async () => built(), [payer], 'proofRequired')).rejects.toThrow(
      /tx başarılı/,
    );
  });

  it('onay zincir hatasıyla reddedilirse tx zincirdedir: kayıt getTransaction’dan okunur', async () => {
    const landed = { InstructionError: [4, { Custom: 6039 }] };
    const failing = fakeConnection({
      confirmError: landed,
      meta: { err: landed, logMessages: escrowFailure(6039) },
    });
    const sender = createSender(failing.connection, client, () => {});
    const record = await sender.send('6 + 8', 'finalize', async () => built(), [payer], 'proofRequired');
    expect(record.error?.name).toBe('proofRequired');
    await expect(sender.send('6 + 8', 'finalize', async () => built(), [payer])).rejects.toThrow(
      /escrow proofRequired/,
    );
    const broken = createSender(fakeConnection({ confirmError: new Error('ağ') }).connection, client, () => {});
    await expect(broken.send('3', 'x', async () => built(), [payer])).rejects.toThrow('ağ');
    expect(isLandedTransactionError('AccountInUse')).toBe(true);
    expect(isLandedTransactionError(null)).toBe(false);
  });

  it('eksik imzacı ve gönderim reddi', async () => {
    const sender = createSender(fakeConnection({}).connection, client, () => {});
    await expect(sender.send('1', 'x', async () => built(), [])).rejects.toThrow(/imzacı verilmedi/);
    const rejected = createSender(
      fakeConnection({ sendError: Object.assign(new Error('sim'), { logs: escrowFailure(6004) }) }).connection,
      client,
      () => {},
    );
    await expect(rejected.send('1', 'x', async () => built(), [payer])).rejects.toThrow(
      /gönderim reddedildi \(escrow: unauthorized\)/,
    );
    const plain = createSender(fakeConnection({ sendError: new Error('ağ') }).connection, client, () => {});
    await expect(plain.send('1', 'x', async () => built(), [payer])).rejects.toThrow(/gönderim reddedildi$/);
  });
});

describe('saat ve slot', () => {
  const clock = (timestamp: number) => {
    const data = Buffer.alloc(40);
    data.writeBigInt64LE(BigInt(timestamp), 32);
    return data;
  };

  it("Clock sysvar'ından unix_timestamp", async () => {
    expect(clockUnixTimestamp(clock(1_790_000_000))).toBe(1_790_000_000);
    expect(() => clockUnixTimestamp(new Uint8Array(8))).toThrow(/40 bayt/);
    const missing = { getAccountInfo: async () => null } as unknown as Connection;
    await expect(chainTime(missing)).rejects.toThrow(/Clock/);
  });

  it('zincirin saati hedefe ulaşana ve kesinleşmiş slot geçene kadar bekler', async () => {
    let now = 100;
    const connection = {
      getAccountInfo: async () => ({ data: clock(now++) }),
      getSlot: async () => now++,
    } as unknown as Connection;
    expect(await waitForChainTime(connection, 102, 1)).toBe(102);
    await waitForFinalizedSlotAfter(connection, 103);
    expect(now).toBeGreaterThan(104);
  });
});

describe('upgradeable loader', () => {
  const programData = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  it('Program → ProgramData adresi', () => {
    const data = Buffer.alloc(36);
    data.writeUInt32LE(2, 0);
    programData.toBuffer().copy(data, 4);
    expect(programDataAddress(data).equals(programData)).toBe(true);
    expect(() => programDataAddress(Buffer.alloc(36))).toThrow(/Program hesabı değil/);
  });

  it('ProgramData: slot, authority (ya da yok) ve executable', () => {
    const header = (withAuthority: boolean) => {
      const data = Buffer.alloc(45 + 4);
      data.writeUInt32LE(3, 0);
      data.writeBigUInt64LE(77n, 4);
      if (withAuthority) {
        data[12] = 1;
        authority.toBuffer().copy(data, 13);
      }
      data.set([9, 8, 0, 0], 45);
      return data;
    };
    const parsed = parseProgramData(header(true));
    expect(parsed.slot).toBe(77);
    expect(parsed.upgradeAuthority!.equals(authority)).toBe(true);
    expect(Array.from(parsed.executable)).toEqual([9, 8, 0, 0]);
    expect(parseProgramData(header(false)).upgradeAuthority).toBeNull();
    expect(() => parseProgramData(Buffer.alloc(10))).toThrow(/ProgramData/);
  });

  it("executable hash'i sondaki sıfırları atar (ProgramData ve .so aynı hash'i verir)", () => {
    const so = Uint8Array.from([1, 2, 3, 0, 4]);
    const padded = Uint8Array.from([...so, 0, 0, 0, 0]);
    expect(executableHash(padded)).toBe(executableHash(so));
    expect(executableHash(so)).not.toBe(executableHash(Uint8Array.from([1, 2, 3])));
    expect(executableHash(new Uint8Array(3))).toBe(executableHash(new Uint8Array(0)));
  });

  it("Squads v4 vault'u indekse göre türetilir ve eğri dışıdır", () => {
    const multisig = Keypair.generate().publicKey;
    const vault0 = squadsVault(multisig, 0);
    expect(vault0.equals(squadsVault(multisig, 1))).toBe(false);
    expect(PublicKey.isOnCurve(vault0.toBytes())).toBe(false);
  });
});
