// İndexlenmiş zincir event'i (indexer BE-14, API `/v1/events`).
import { z } from 'zod';
import { ProgramEventPayloadSchema } from './generated/idl.js';
import { I64, Signature } from './primitives.js';

export const IndexedEventSchema = z.object({
  signature: Signature,
  slot: z.number().int().min(0),
  blockTime: I64.nullable(),
  instructionIndex: z.number().int().min(0),
  eventIndex: z.number().int().min(0),
  payload: ProgramEventPayloadSchema,
});
export type IndexedEvent = z.infer<typeof IndexedEventSchema>;
