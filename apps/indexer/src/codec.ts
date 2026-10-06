// Zincir verisinin çözülmesi: tx loglarındaki event'ler ve Square programlarının hesapları, IDL JSON
// kodlamasıyla (api-sdk-contract §3). Çıktı API sözleşmesinin üretilen şemalarıyla doğrulanır; şemaya uymayan
// değer veritabanına yazılmaz, hata verir.
import type { Idl, Program } from '@anchor-lang/core';
import { SQUARE_IDLS, toIdlJson, type IdlJson, type SquareClient, type SquareProgramName } from '@squaresdk/solana-sdk';
import * as types from '@squaresdk/solana-types';
import { ProgramEventPayloadSchema, type ProgramEventPayload } from '@squaresdk/solana-types';
import type { AccountInfo, PublicKey } from '@solana/web3.js';
import type { FinalizedTransaction } from './chain.js';

/** Ayna tablosu olan hesap tipleri (veri modeli §2); config ve operatör hesapları aynalanmaz. */
export const MIRRORED_ACCOUNTS = {
  policy: ['Institution', 'Policy'],
  registry: ['AgentRecord', 'ScreeningRecord'],
  escrow: ['Job', 'ClaimListing', 'AgentReputation', 'ValidationRecord'],
  verifier: ['ReleaseProof'],
} as const satisfies Record<SquareProgramName, readonly string[]>;

export type MirroredAccount = (typeof MIRRORED_ACCOUNTS)[SquareProgramName][number];

export interface AccountKind {
  readonly program: SquareProgramName;
  readonly kind: MirroredAccount;
  readonly programId: PublicKey;
  readonly discriminator: Uint8Array;
}

export interface DecodedAccount {
  readonly program: SquareProgramName;
  readonly kind: MirroredAccount;
  /** Hesabın IDL JSON'u (ayna tablonun `account` sütunu). */
  readonly json: Readonly<Record<string, IdlJson>>;
}

export interface EventRecord {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly instructionIndex: number;
  readonly eventIndex: number;
  readonly program: SquareProgramName;
  /** IDL event adı (`JobCreated`). */
  readonly name: string;
  /** Event bir job'a aitse job adresi. */
  readonly job: string | null;
  readonly payload: ProgramEventPayload;
}

export interface Codec {
  readonly accountKinds: readonly AccountKind[];
  events(tx: FinalizedTransaction): { events: EventRecord[]; truncated: boolean };
  /**
   * Aynalanan bir Square hesabı değilse (başka sahip, config hesabı) null. Sahibi ve discriminator'ı
   * aynalanan bir tipe uyup sözleşme IDL'iyle çözülemeyen hesapta `UndecodableAccountError`.
   */
  account(address: string, info: AccountInfo<Buffer>): DecodedAccount | null;
}

/**
 * Programın hesabı sözleşme IDL'iyle çözülemiyor: aynı program kimliğindeki eski bir dağıtımın düzeni (ör.
 * devnet'te yeniden kullanılan adres). Ayna tabloya yazılmaz; çağıran atlar, sayar ve raporlar.
 */
export class UndecodableAccountError extends Error {
  constructor(
    readonly program: SquareProgramName,
    readonly kind: MirroredAccount,
    readonly address: string,
    cause: unknown,
  ) {
    super(`${program}.${kind} hesabı ${address} sözleşme IDL'iyle çözülemedi`, { cause });
    this.name = 'UndecodableAccountError';
  }
}

interface Schema {
  parse(value: unknown): unknown;
}
const schemas = types as unknown as Record<string, Schema | undefined>;

function schemaOf(name: string): Schema {
  const schema = schemas[`${name}Schema`];
  if (!schema) throw new Error(`@squaresdk/solana-types'ta ${name}Schema yok`);
  return schema;
}

const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('hex');

interface KindEntry extends AccountKind {
  readonly anchor: Program<Idl>;
  /** Anchor'ın camelCase hesap adı. */
  readonly camel: string;
  readonly schema: Schema;
}

export function createCodec(client: SquareClient): Codec {
  const anchors = {
    registry: client.registry.program,
    policy: client.policy.program,
    verifier: client.verifier.program,
    escrow: client.escrow.program,
  } as unknown as Record<SquareProgramName, Program<Idl>>;

  // Ham IDL (`Job`) ile Anchor'ın camelCase IDL'i (`job`) aynı sıradadır.
  const kinds: KindEntry[] = (Object.keys(MIRRORED_ACCOUNTS) as SquareProgramName[]).flatMap((program) => {
    const anchor = anchors[program];
    const raw = SQUARE_IDLS[program].accounts as readonly { name: string }[];
    return (MIRRORED_ACCOUNTS[program] as readonly MirroredAccount[]).map((kind) => {
      const index = raw.findIndex((account) => account.name === kind);
      const camel = anchor.idl.accounts![index]!;
      return {
        program,
        kind,
        programId: anchor.programId,
        discriminator: Uint8Array.from(camel.discriminator),
        anchor,
        camel: camel.name,
        schema: schemaOf(kind),
      };
    });
  });
  const byDiscriminator = new Map(kinds.map((entry) => [hex(entry.discriminator), entry]));

  const eventNames = new Map(
    (Object.keys(anchors) as SquareProgramName[]).flatMap((program) => {
      const raw = SQUARE_IDLS[program].events as readonly { name: string }[];
      return (anchors[program].idl.events ?? []).map((event, index) => [`${program}:${event.name}`, raw[index]!.name]);
    }),
  );

  return {
    accountKinds: kinds.map(({ program, kind, programId, discriminator }) => ({
      program,
      kind,
      programId,
      discriminator,
    })),

    events(tx) {
      const decoded = client.decodeTransactionEvents(tx.logs, { signature: tx.signature, slot: tx.slot });
      const events = decoded.events.map((event): EventRecord => {
        const anchor = anchors[event.program];
        const name = eventNames.get(`${event.program}:${event.name}`)!;
        const data = toIdlJson(anchor.idl, { defined: { name: event.name } }, event.data);
        const payload = ProgramEventPayloadSchema.parse({ program: event.program, name, data });
        const job = (data as Record<string, IdlJson>).job;
        return {
          signature: tx.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          instructionIndex: event.instructionIndex,
          eventIndex: event.eventIndex,
          program: event.program,
          name,
          job: typeof job === 'string' ? job : null,
          payload,
        };
      });
      return { events, truncated: decoded.truncated };
    },

    account(address, info) {
      if (info.data.length < 8) return null;
      const entry = byDiscriminator.get(hex(info.data.subarray(0, 8)));
      if (!entry || !info.owner.equals(entry.programId)) return null;
      try {
        const value: unknown = entry.anchor.coder.accounts.decode(entry.camel, info.data);
        const json = toIdlJson(entry.anchor.idl, { defined: { name: entry.camel } }, value);
        entry.schema.parse(json);
        return { program: entry.program, kind: entry.kind, json: json as Record<string, IdlJson> };
      } catch (error) {
        throw new UndecodableAccountError(entry.program, entry.kind, address, error);
      }
    },
  };
}
