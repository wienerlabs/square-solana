'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'size-4',
  'aria-hidden': true,
} as const;

const OPTIONS = [
  {
    value: 'light',
    label: 'Light',
    icon: (
      <svg {...ICON_PROPS}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'System',
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
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
      className="inline-flex rounded-[10px] border border-border/80 bg-surface/60 p-0.5"
    >
      {OPTIONS.map((option) => {
        const pressed = mounted && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            aria-label={option.label}
            title={option.label}
            onClick={() => setTheme(option.value)}
            className={`flex size-8 items-center justify-center rounded-lg transition-colors ${
              pressed ? 'bg-surface-muted text-text shadow-sm' : 'text-muted hover:text-text'
            }`}
          >
            {option.icon}
          </button>
        );
      })}
    </div>
  );
}
