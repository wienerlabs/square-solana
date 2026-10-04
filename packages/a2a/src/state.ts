// Görev durum makinesi ve job durumuyla tutarlılık (docs/design/a2a.md §3). Görev agent'ın işidir:
// WORKING kabul edilmiş, COMPLETED teslim edilmiş bir job ister; terminal görev değişmez.
import {
  INTERRUPTED_TASK_STATES,
  JOB_STATUS_TO_TASK_STATE,
  TERMINAL_TASK_STATES,
  type JobStatus,
  type TaskState,
} from '@squaresdk/solana-types';

export const isTerminal = (state: TaskState) => TERMINAL_TASK_STATES.has(state);

/** Görev durumu → yazılabileceği job durumları. */
const CONSISTENT: Readonly<Record<TaskState, ReadonlySet<JobStatus>>> = {
  TASK_STATE_SUBMITTED: new Set(['open', 'funded']),
  TASK_STATE_WORKING: new Set(['accepted']),
  TASK_STATE_INPUT_REQUIRED: new Set(['open', 'funded', 'accepted']),
  TASK_STATE_AUTH_REQUIRED: new Set(['open', 'funded', 'accepted']),
  TASK_STATE_COMPLETED: new Set(['delivered', 'disputed', 'resolved', 'released', 'refunded']),
  TASK_STATE_FAILED: new Set(['open', 'funded', 'accepted']),
  TASK_STATE_REJECTED: new Set(['open', 'funded']),
  TASK_STATE_CANCELED: new Set(['open', 'funded', 'cancelled']),
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  if (isTerminal(from)) return false;
  if (to === 'TASK_STATE_SUBMITTED') return from === 'TASK_STATE_SUBMITTED' || INTERRUPTED_TASK_STATES.has(from);
  return true;
}

export function consistentWithJob(state: TaskState, jobStatus: JobStatus): boolean {
  return CONSISTENT[state].has(jobStatus);
}

/** Zincirdeki job durumuna göre görevin yeni durumu; yalnızca ileri gider, terminal görevi değiştirmez. */
export function reconcile(current: TaskState, jobStatus: JobStatus): TaskState {
  if (isTerminal(current)) return current;
  const implied = JOB_STATUS_TO_TASK_STATE[jobStatus];
  if (isTerminal(implied)) return implied;
  if (implied === 'TASK_STATE_WORKING' && current === 'TASK_STATE_SUBMITTED') return implied;
  return current;
}

/** İstemci iptali: agent job'u zincirde kabul etmeden önce ya da job iptal edilmişse. */
export function cancelable(current: TaskState, jobStatus: JobStatus): boolean {
  if (isTerminal(current)) return false;
  return jobStatus === 'open' || jobStatus === 'funded' || jobStatus === 'cancelled';
}
