import type { Connection, PublicKey } from '@solana/web3.js';
import type { SquareClient } from '@squaresdk/solana-sdk';
import type { EventKey } from './events.js';

const PAGE = 1_000;

export async function finalizedSignatures(connection: Connection, programs: readonly PublicKey[]): Promise<string[]> {
  const signatures = new Set<string>();
  for (const program of programs) {
    let before: string | undefined;
    for (;;) {
      const page = await connection.getSignaturesForAddress(
        program,
        { limit: PAGE, ...(before ? { before } : {}) },
        'finalized',
      );
      for (const info of page) if (info.err === null) signatures.add(info.signature);
      if (page.length < PAGE) break;
      before = page.at(-1)!.signature;
    }
  }
  return [...signatures];
}

export async function chainEventKeys(
  connection: Connection,
  client: SquareClient,
  programs: readonly PublicKey[],
): Promise<EventKey[]> {
  const events: EventKey[] = [];
  for (const signature of await finalizedSignatures(connection, programs)) {
    const tx = await connection.getTransaction(signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) throw new Error(`kesinleşmiş tx okunamadı: ${signature}`);
    const decoded = client.decodeTransactionEvents(tx.meta.logMessages ?? [], { signature, slot: tx.slot });
    for (const event of decoded.events) {
      events.push({
        signature,
        instructionIndex: event.instructionIndex,
        eventIndex: event.eventIndex,
        program: event.program,
        name: event.name,
      });
    }
  }
  return events;
}
