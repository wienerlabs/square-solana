// Görev olayları (docs/design/a2a.md §5): depo yazıldıktan sonra yayımlanır; akışlar ve bekleyen
// SendMessage çağrıları dinler. Süreç içidir; birden çok örnekte paylaşılan bir veriyolu bu arayüzü uygular.
import type { Artifact } from '@squaresdk/solana-types';
import type { TaskRecord } from './store.js';

export type TaskEvent =
  | { kind: 'status'; task: TaskRecord }
  | { kind: 'artifact'; task: TaskRecord; artifact: Artifact; append: boolean; lastChunk: boolean };

export type TaskEventListener = (event: TaskEvent) => void;

export interface TaskEventBus {
  publish(taskId: string, event: TaskEvent): void;
  /** Dinlemeyi bırakan fonksiyonu döner. */
  subscribe(taskId: string, listener: TaskEventListener): () => void;
}

export function createTaskEventBus(): TaskEventBus {
  const listeners = new Map<string, Set<TaskEventListener>>();
  return {
    publish(taskId, event) {
      for (const listener of [...(listeners.get(taskId) ?? [])]) listener(event);
    },
    subscribe(taskId, listener) {
      const set = listeners.get(taskId) ?? new Set();
      set.add(listener);
      listeners.set(taskId, set);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        set.delete(listener);
        if (set.size === 0 && listeners.get(taskId) === set) listeners.delete(taskId);
      };
    },
  };
}
