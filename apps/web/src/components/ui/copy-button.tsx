'use client';

import { useEffect, useState } from 'react';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        className="rounded-md px-1.5 py-0.5 text-caption text-muted transition-colors hover:bg-surface-muted hover:text-text"
      >
        <span
          key={state}
          className={`inline-block ${state === 'copied' ? 'text-tone-fg motion-safe:animate-[sq-pop_0.35s_ease-out]' : ''}`}
        >
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
        </span>
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Could not copy' : ''}
      </span>
    </>
  );
}
