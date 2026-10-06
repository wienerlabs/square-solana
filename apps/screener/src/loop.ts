// Periyodik iş: bir koşu bitmeden sonraki başlamaz; koşular arasında `intervalMs` beklenir. Hata döngüyü
// durdurmaz, `onError`'a gider. Durdurma, süren koşunun bitmesini bekler.
export function startLoop(params: {
  intervalMs: number;
  /** İlk koşu hemen mi, bir aralık sonra mı. */
  immediate: boolean;
  run: () => Promise<unknown>;
  onError: (error: unknown) => void;
}): () => Promise<void> {
  if (!(params.intervalMs > 0)) throw new Error('intervalMs pozitif olmalı');
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, params.intervalMs);
  };
  function tick() {
    current = params
      .run()
      .then(
        () => undefined,
        (error: unknown) => params.onError(error),
      )
      .then(schedule);
  }

  if (params.immediate) tick();
  else schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await current;
  };
}
