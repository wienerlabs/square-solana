import { Reveal } from '@/components/ui/reveal';
import { PILLARS } from './content';

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'size-5',
  'aria-hidden': true,
} as const;

/** Sütun başına süs ikonu: kilit (gizli yetki), kalkan (ispat), kimlik kartı (agent ve alıcı). */
const ICONS = [
  <svg key="mandate" {...ICON_PROPS}>
    <rect x="4" y="10" width="16" height="10" rx="2.5" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>,
  <svg key="proof" {...ICON_PROPS}>
    <path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>,
  <svg key="identity" {...ICON_PROPS}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <circle cx="9" cy="11" r="2.2" />
    <path d="M5.8 16.2a3.6 3.6 0 0 1 6.4 0M14 10h4M14 13.5h3" />
  </svg>,
];

export function Pillars() {
  return (
    <section aria-labelledby="pillars-title" className="py-12">
      <Reveal>
        <p className="text-caption font-medium tracking-[0.14em] text-muted uppercase">Why Square</p>
        <h2 id="pillars-title" className="mt-2 text-heading-sm font-semibold tracking-tight md:text-heading">
          What Square does
        </h2>
      </Reveal>
      <ul className="mt-8 grid gap-4 md:grid-cols-3">
        {PILLARS.map((pillar, index) => (
          <Reveal as="li" key={pillar.title} delay={index * 90} className="card card-interactive group p-6">
            <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-surface-muted text-link transition-colors group-hover:border-accent/50">
              {ICONS[index]}
            </span>
            <h3 className="mt-5 text-subheading font-semibold tracking-tight">{pillar.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{pillar.body}</p>
          </Reveal>
        ))}
      </ul>
    </section>
  );
}
