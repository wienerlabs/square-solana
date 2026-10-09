import type { ReactNode } from 'react';

export type Tone = 'info' | 'warning' | 'success' | 'danger' | 'neutral';

const TONES: Record<Tone, { bg: string; dot: string; ring: string; live: boolean }> = {
  info: { bg: 'bg-tone-info-bg', dot: 'bg-tone-info-dot', ring: 'ring-tone-info-dot/25', live: true },
  warning: { bg: 'bg-tone-warning-bg', dot: 'bg-tone-warning-dot', ring: 'ring-tone-warning-dot/25', live: true },
  success: { bg: 'bg-tone-success-bg', dot: 'bg-tone-success-dot', ring: 'ring-tone-success-dot/25', live: false },
  danger: { bg: 'bg-tone-danger-bg', dot: 'bg-tone-danger-dot', ring: 'ring-tone-danger-dot/25', live: false },
  neutral: { bg: 'bg-tone-neutral-bg', dot: 'bg-tone-neutral-dot', ring: 'ring-tone-neutral-dot/20', live: false },
};

// Anlam etiketin metninde; renk ve nokta yalnızca destekler (WCAG 1.4.1).
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const look = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-caption font-medium text-tone-fg ring-1 ring-inset ${look.bg} ${look.ring}`}
    >
      <span aria-hidden="true" className="relative flex size-1.5">
        {/* Bekleyen durumlar (bilgi, uyarı) canlı: nokta hafifçe yayılır. */}
        {look.live && (
          <span
            className={`absolute inline-flex size-full rounded-full motion-safe:animate-[sq-ping_2.2s_ease-out_infinite] ${look.dot}`}
          />
        )}
        <span className={`relative inline-flex size-1.5 rounded-full ${look.dot}`} />
      </span>
      {children}
    </span>
  );
}
