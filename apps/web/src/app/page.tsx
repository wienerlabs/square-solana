'use client';

import Link from 'next/link';
import { useWebConfig } from '@/components/providers';
import { Flow } from '@/components/landing/flow';
import { Hero } from '@/components/landing/hero';
import { OnChain } from '@/components/landing/on-chain';
import { Pillars } from '@/components/landing/pillars';
import { Reveal } from '@/components/ui/reveal';

export default function LandingPage() {
  const { cluster } = useWebConfig();
  return (
    <main className="mx-auto max-w-5xl px-6">
      <Hero cluster={cluster} />
      <Pillars />
      <Flow />
      <OnChain />
      <Reveal
        as="section"
        aria-labelledby="cta-title"
        className="card relative my-16 overflow-hidden p-10 text-center md:p-14"
      >
        <div
          aria-hidden="true"
          className="absolute -top-24 left-1/2 h-48 w-[36rem] -translate-x-1/2 rounded-full bg-[color-mix(in_oklab,var(--sq-accent)_35%,transparent)] blur-3xl"
        />
        <h2 id="cta-title" className="relative text-heading-sm font-semibold tracking-tight md:text-heading">
          Connect a wallet and follow the flow.
        </h2>
        <p className="relative mx-auto mt-3 max-w-xl text-sm text-muted">
          Commit a policy, open a job, bind the proof and watch the escrow pay out, all on {cluster}.
        </p>
        <Link
          href="/app"
          className="group shine relative mt-8 inline-flex h-11 items-center gap-2 rounded-[10px] bg-accent px-6 font-medium text-on-accent shadow-[inset_0_1px_0_0_rgb(255_255_255/0.35),0_10px_30px_-12px_var(--sq-accent)] transition-all hover:bg-accent-hover active:scale-[0.98]"
        >
          Open the app
          <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </Link>
      </Reveal>
    </main>
  );
}
