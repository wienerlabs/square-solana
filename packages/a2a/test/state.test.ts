import { JobStatusSchema, TaskStateSchema, type JobStatus, type TaskState } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { canTransition, cancelable, consistentWithJob, isTerminal, reconcile } from '../src/state.js';

const STATES = TaskStateSchema.options;
const JOBS = JobStatusSchema.options;

describe('canTransition', () => {
  it('terminal görev hiçbir duruma geçmez', () => {
    for (const from of [
      'TASK_STATE_COMPLETED',
      'TASK_STATE_FAILED',
      'TASK_STATE_CANCELED',
      'TASK_STATE_REJECTED',
    ] as const) {
      for (const to of STATES) expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
    }
  });

  it('SUBMITTED yalnızca başlangıç ya da kesintiden dönüş durumudur', () => {
    expect(canTransition('TASK_STATE_SUBMITTED', 'TASK_STATE_SUBMITTED')).toBe(true);
    expect(canTransition('TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_SUBMITTED')).toBe(true);
    expect(canTransition('TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED')).toBe(false);
  });

  it('terminal olmayan görev ilerler', () => {
    expect(canTransition('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING')).toBe(true);
    expect(canTransition('TASK_STATE_WORKING', 'TASK_STATE_COMPLETED')).toBe(true);
    expect(canTransition('TASK_STATE_WORKING', 'TASK_STATE_WORKING')).toBe(true);
    expect(canTransition('TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_FAILED')).toBe(true);
  });
});

describe('consistentWithJob', () => {
  const allowed: Record<TaskState, readonly JobStatus[]> = {
    TASK_STATE_SUBMITTED: ['open', 'funded'],
    TASK_STATE_WORKING: ['accepted'],
    TASK_STATE_INPUT_REQUIRED: ['open', 'funded', 'accepted'],
    TASK_STATE_AUTH_REQUIRED: ['open', 'funded', 'accepted'],
    TASK_STATE_COMPLETED: ['delivered', 'disputed', 'resolved', 'released', 'refunded'],
    TASK_STATE_FAILED: ['open', 'funded', 'accepted'],
    TASK_STATE_REJECTED: ['open', 'funded'],
    TASK_STATE_CANCELED: ['open', 'funded', 'cancelled'],
  };

  it('her görev durumu yalnızca tutarlı job durumlarında yazılabilir', () => {
    for (const state of STATES) {
      for (const job of JOBS) {
        expect(consistentWithJob(state, job), `${state} / ${job}`).toBe(allowed[state].includes(job));
      }
    }
  });
});

describe('reconcile', () => {
  it('zincir ilerledikçe görev ileri gider, geri gitmez', () => {
    expect(reconcile('TASK_STATE_SUBMITTED', 'accepted')).toBe('TASK_STATE_WORKING');
    expect(reconcile('TASK_STATE_WORKING', 'delivered')).toBe('TASK_STATE_COMPLETED');
    expect(reconcile('TASK_STATE_SUBMITTED', 'cancelled')).toBe('TASK_STATE_CANCELED');
    expect(reconcile('TASK_STATE_WORKING', 'funded')).toBe('TASK_STATE_WORKING');
    expect(reconcile('TASK_STATE_INPUT_REQUIRED', 'accepted')).toBe('TASK_STATE_INPUT_REQUIRED');
  });

  it('terminal görev settlement ile değişmez', () => {
    for (const job of ['disputed', 'resolved', 'released', 'refunded', 'cancelled'] as const) {
      expect(reconcile('TASK_STATE_COMPLETED', job)).toBe('TASK_STATE_COMPLETED');
      expect(reconcile('TASK_STATE_FAILED', job)).toBe('TASK_STATE_FAILED');
    }
  });
});

describe('cancelable', () => {
  it('yalnızca kabulden önce ya da job iptal edilmişse', () => {
    expect(cancelable('TASK_STATE_SUBMITTED', 'funded')).toBe(true);
    expect(cancelable('TASK_STATE_INPUT_REQUIRED', 'open')).toBe(true);
    expect(cancelable('TASK_STATE_WORKING', 'accepted')).toBe(false);
    expect(cancelable('TASK_STATE_WORKING', 'cancelled')).toBe(true);
    expect(cancelable('TASK_STATE_COMPLETED', 'delivered')).toBe(false);
  });

  it('isTerminal', () => {
    expect(isTerminal('TASK_STATE_REJECTED')).toBe(true);
    expect(isTerminal('TASK_STATE_AUTH_REQUIRED')).toBe(false);
  });
});
