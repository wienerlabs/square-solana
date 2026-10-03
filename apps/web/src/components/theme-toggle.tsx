'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const;

const subscribe = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // Seçili tema yalnızca istemcide bilinir; sunucu render'ında hiçbir düğme basılı görünmez.
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="inline-flex rounded-full border border-border bg-surface p-0.5"
    >
      {OPTIONS.map((option) => {
        const pressed = mounted && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => setTheme(option.value)}
            className={`rounded-full px-3 py-1 text-caption font-medium transition-colors ${
              pressed ? 'bg-surface-muted text-text' : 'text-muted hover:text-text'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
