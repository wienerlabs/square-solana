import type { ReactNode } from 'react';

export type Tone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

const TONES: Record<Tone, { bg: string; dot: string }> = {
  info: { bg: 'bg-tone-info-bg', dot: 'bg-tone-info-dot' },
  warning: { bg: 'bg-tone-warning-bg', dot: 'bg-tone-warning-dot' },
  success: { bg: 'bg-tone-success-bg', dot: 'bg-tone-success-dot' },
  danger: { bg: 'bg-tone-danger-bg', dot: 'bg-tone-danger-dot' },
  neutral: { bg: 'bg-tone-neutral-bg', dot: 'bg-tone-neutral-dot' },
};

// Anlam etiketin metninde; renk ve nokta yalnızca destekler (WCAG 1.4.1).
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const look = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-caption font-medium text-tone-fg ${look.bg}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${look.dot}`} />
      {children}
    </span>
  );
}
