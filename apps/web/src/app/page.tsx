'use client';

import Link from 'next/link';
import { useWebConfig } from '@/components/providers';
import { Flow } from '@/components/landing/flow';
import { Hero } from '@/components/landing/hero';
import { OnChain } from '@/components/landing/on-chain';
import { Pillars } from '@/components/landing/pillars';

export default function LandingPage() {
  const { cluster } = useWebConfig();
  return (
    <main className="mx-auto max-w-5xl px-6">
      <Hero cluster={cluster} />
      <Pillars />
      <Flow />
      <OnChain />
      <section
        aria-labelledby="cta-title"
        className="my-12 rounded-card border border-border bg-surface p-8 text-center"
      >
        <h2 id="cta-title" className="text-heading-sm font-semibold">
          Connect a wallet and follow the flow.
        </h2>
        <Link
          href="/app"
          className="mt-6 inline-flex h-11 items-center rounded-full bg-accent px-6 font-medium text-on-accent hover:bg-accent-hover"
        >
          Open the app
        </Link>
      </section>
    </main>
  );
}
