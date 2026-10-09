import Link from 'next/link';

/** Hero'nun sağındaki süs: ödemenin yolu (yetki → ispat → ödeme), yalnızca görsel. */
function SettlementVisual() {
  const rows = [
    { label: 'Mandate', detail: 'Poseidon commitment · daily ceiling', tone: 'var(--sq-accent)' },
    { label: 'Zero-knowledge proof', detail: 'Groth16 · 13 public signals', tone: 'var(--sq-tone-info-dot)' },
    { label: 'Release', detail: 'escrow → payee, keeper fee', tone: 'var(--sq-tone-success-dot)' },
  ];
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-sm select-none motion-safe:hover-float lg:mx-0">
      <div className="absolute -inset-6 rounded-[28px] bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--sq-accent)_30%,transparent),transparent)] blur-2xl" />
      <div className="card relative overflow-hidden p-5">
        <div className="flex items-center justify-between text-caption text-muted">
          <span className="font-mono">job · 5 USDC</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-tone-success-bg px-2 py-0.5 font-medium text-tone-fg">
            <span className="size-1.5 rounded-full bg-tone-success-dot" />
            Verified
          </span>
        </div>
        <div className="relative mt-5">
          <svg
            className="absolute top-4 left-[15px] h-[calc(100%-2rem)] w-px overflow-visible"
            preserveAspectRatio="none"
          >
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="100%"
              stroke="var(--sq-border)"
              strokeWidth="2"
              strokeDasharray="4 8"
              className="motion-safe:animate-[sq-dash_1.2s_linear_infinite]"
            />
          </svg>
          <ol className="relative grid gap-5">
            {rows.map((row, index) => (
              <li
                key={row.label}
                className="relative flex items-center gap-4 motion-safe:animate-[sq-rise_0.6s_cubic-bezier(0.2,0.7,0.2,1)_both]"
                style={{ animationDelay: `${300 + index * 180}ms` }}
              >
                <span
                  className="relative flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface"
                  style={{ boxShadow: `0 0 0 4px color-mix(in oklab, ${row.tone} 18%, transparent)` }}
                >
                  <span className="size-2.5 rounded-full" style={{ background: row.tone }} />
                </span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{row.label}</span>
                  <span className="font-mono text-caption text-muted">{row.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="mt-6 h-1.5 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full w-full origin-left rounded-full bg-[linear-gradient(90deg,var(--sq-accent),var(--sq-tone-info-dot),var(--sq-tone-success-dot))] motion-safe:animate-[sq-fill_2.4s_cubic-bezier(0.2,0.7,0.2,1)_both]" />
        </div>
      </div>
    </div>
  );
}

export function Hero({ cluster }: { cluster: string }) {
  return (
    <section aria-labelledby="hero-title" className="grid items-center gap-12 py-16 md:py-24 lg:grid-cols-[1.2fr_1fr]">
      <div className="rise-in-self">
        <p className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-surface/60 px-3 py-1 text-caption text-muted backdrop-blur">
          <span aria-hidden="true" className="relative flex size-1.5">
            <span className="absolute inline-flex size-full rounded-full bg-tone-success-dot motion-safe:animate-[sq-ping_2.4s_ease-out_infinite]" />
            <span className="relative inline-flex size-1.5 rounded-full bg-tone-success-dot" />
          </span>
          Square on Solana · <span className="font-mono">{cluster}</span>
        </p>
        <h1
          id="hero-title"
          className="mt-6 max-w-3xl text-heading font-semibold tracking-tight text-balance md:text-display"
        >
          {/* Bölünmez kısa çizgi (U+2011): başlık "Compliance-" ile "gated" arasından kırılmaz. */}
          <span className="text-gradient">Compliance‑gated settlement</span> for agent work.
        </h1>
        <p className="mt-6 max-w-2xl text-subheading text-muted">
          An institution commits a spending mandate without publishing it. Identified agents deliver against it, and the
          escrow pays out only when a zero-knowledge proof shows the release fits the mandate.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/app"
            className="group shine inline-flex h-11 items-center gap-2 rounded-[10px] bg-accent px-5 font-medium text-on-accent shadow-[inset_0_1px_0_0_rgb(255_255_255/0.35),0_10px_30px_-12px_var(--sq-accent)] transition-all hover:bg-accent-hover active:scale-[0.98]"
          >
            Open the app
            <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </Link>
          <Link
            href="/app/network"
            className="inline-flex h-11 items-center rounded-[10px] border border-border bg-surface/70 px-5 font-medium text-text backdrop-blur transition-colors hover:bg-surface-muted"
          >
            See the network
          </Link>
        </div>
      </div>
      <SettlementVisual />
    </section>
  );
}
