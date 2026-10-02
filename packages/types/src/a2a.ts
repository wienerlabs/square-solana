// A2A görev modeli (JSON-RPC 2.0) ve job durumu ↔ görev durumu eşlemesi. Kesinleşmesi BE-17'de.
import { z } from 'zod';
import type { JobStatus } from './generated/idl.js';
import { Address, Hex32 } from './primitives.js';

export const TaskStateSchema = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'auth-required',
  'unknown',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: z.object({
    state: TaskStateSchema,
    timestamp: z.iso.datetime(),
    message: z.string().max(2000).optional(),
  }),
  metadata: z.object({
    square: z.object({ job: Address, specHash: Hex32 }),
  }),
});
export type Task = z.infer<typeof TaskSchema>;

/** Job durumu → A2A görev durumu (taslak, BE-17). */
export const JOB_STATUS_TO_TASK_STATE: Readonly<Record<JobStatus, TaskState>> = {
  open: 'submitted',
  funded: 'submitted',
  accepted: 'working',
  delivered: 'completed',
  disputed: 'input-required',
  resolved: 'completed',
  released: 'completed',
  refunded: 'failed',
  cancelled: 'canceled',
};
