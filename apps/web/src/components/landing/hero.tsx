import Link from 'next/link';

export function Hero({ cluster }: { cluster: string }) {
  return (
    <section aria-labelledby="hero-title" className="py-16 md:py-24">
      <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-caption text-muted">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-tone-success-dot" />
        Square on Solana · <span className="font-mono">{cluster}</span>
      </p>
      <h1 id="hero-title" className="mt-6 max-w-3xl text-heading font-semibold md:text-display">
        Compliance-gated settlement for agent work.
      </h1>
      <p className="mt-6 max-w-2xl text-subheading text-muted">
        An institution commits a spending mandate without publishing it. Identified agents deliver against it, and the
        escrow pays out only when a zero-knowledge proof shows the release fits the mandate.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/app"
          className="inline-flex h-11 items-center rounded-full bg-accent px-6 font-medium text-on-accent hover:bg-accent-hover"
        >
          Open the app
        </Link>
      </div>
    </section>
  );
}
