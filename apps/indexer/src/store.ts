// Veritabanına yazma: event'ler, ayna satırları ve imleç. Yazmalar idempotenttir:
// - Event `(imza, talimat, event)` anahtarıyla bir kez yazılır; aynı tx'in yeniden işlenmesi satır eklemez.
// - Ayna satırı yalnızca yeni okuma eskisinden eski değilse (`slot <=`) güncellenir; sırasız gelen işlemler
//   (webhook, tarama, uzlaştırma) daha yeni durumu ezmez.
// - Hesap zincirde yoksa kapanabilen tablolarda (`jobs`, `claims`) `closedSlot` yazılır, diğerlerinde satır
//   silinir. Yeniden açılan hesap (aynı PDA'da yeni alacak listelemesi) satırı yeniden açar.
// Yazmalar tek yazıcıdan yapılır (`exclusive`); güncelle-yoksa-ekle adımları başka bir yazmayla iç içe geçmez.
import type { Prisma, ProgramName } from '@squaresdk/solana-db';
import type { DecodedAccount, EventRecord } from './codec.js';
import { TABLES, disputeColumns, type MirrorColumns, type MirrorTable, type TableSpec } from './mirror.js';

export type Tx = Prisma.TransactionClient;

/** Okunan hesap durumu: zincirde yoksa `account` null. */
export interface AccountState {
  readonly address: string;
  readonly account: DecodedAccount | null;
}

export interface CursorPosition {
  readonly program: ProgramName;
  readonly slot: number;
  readonly signature: string;
}

interface Delegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  createMany(args: { data: Record<string, unknown>[]; skipDuplicates: boolean }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

const delegate = (tx: Tx, table: MirrorTable | 'dispute'): Delegate => tx[table] as unknown as Delegate;
const SPECS: readonly TableSpec[] = Object.values(TABLES);

async function upsertNewer(target: Delegate, key: string, row: MirrorColumns & { slot: bigint }): Promise<void> {
  const { count } = await target.updateMany({ where: { [key]: row[key], slot: { lte: row.slot } }, data: row });
  if (count === 0) await target.createMany({ data: [row], skipDuplicates: true });
}

export async function writeEvents(tx: Tx, events: readonly EventRecord[]): Promise<number> {
  if (events.length === 0) return 0;
  const { count } = await tx.chainEvent.createMany({
    data: events.map((event) => ({
      signature: event.signature,
      slot: BigInt(event.slot),
      blockTime: event.blockTime === null ? null : BigInt(event.blockTime),
      instructionIndex: event.instructionIndex,
      eventIndex: event.eventIndex,
      program: event.program,
      name: event.name,
      job: event.job,
      payload: event.payload as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** Hesap durumlarını `slot`'ta okunmuş olarak yazar. */
export async function writeAccountStates(
  tx: Tx,
  states: readonly AccountState[],
  slot: number,
  indexedAt: Date,
): Promise<void> {
  const at = BigInt(slot);
  for (const { address, account } of states) {
    if (account) {
      const spec = TABLES[account.kind];
      const row = {
        address,
        ...spec.columns(account.json),
        account: account.json as Prisma.InputJsonValue,
        slot: at,
        indexedAt,
        ...(spec.closable ? { closedSlot: null } : {}),
      };
      await upsertNewer(delegate(tx, spec.table), 'address', row);
      if (account.kind === 'Job') {
        const dispute = disputeColumns(account.json);
        if (dispute)
          await upsertNewer(delegate(tx, 'dispute'), 'job', { job: address, ...dispute, slot: at, indexedAt });
        else await delegate(tx, 'dispute').deleteMany({ where: { job: address, slot: { lte: at } } });
      }
      continue;
    }
    for (const spec of SPECS) {
      const target = delegate(tx, spec.table);
      if (spec.closable) {
        await target.updateMany({
          where: { address, closedSlot: null, slot: { lte: at } },
          data: { closedSlot: at, slot: at, indexedAt },
        });
      } else {
        await target.deleteMany({ where: { address, slot: { lte: at } } });
      }
    }
  }
}

export async function writeCursor(tx: Tx, cursor: CursorPosition): Promise<void> {
  const data = { lastSlot: BigInt(cursor.slot), lastSignature: cursor.signature };
  await tx.indexerCursor.upsert({
    where: { program: cursor.program },
    create: { program: cursor.program, ...data },
    update: data,
  });
}
