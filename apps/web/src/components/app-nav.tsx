'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLayoutEffect, useRef, useState } from 'react';
import { useRole } from './role-provider';

const SECTIONS = [
  { href: '/app', label: 'Overview' },
  { href: '/app/account', label: 'Account' },
  { href: '/app/network', label: 'Network' },
  { href: '/app/policy', label: 'Policy' },
  { href: '/app/agent', label: 'Agent' },
  { href: '/app/agents', label: 'Directory' },
  { href: '/app/jobs/new', label: 'New job' },
  { href: '/app/claims', label: 'Receivables' },
  { href: '/app/did', label: 'Resolve DID' },
  { href: '/app/developers', label: 'Developers' },
] as const;

/** Arbitrator rolündeki cüzdana konsol bağlantısı (FE-17). */
const ARBITRATION = { href: '/app/arbitration', label: 'Arbitration' } as const;

type Indicator = { left: number; width: number } | null;

export function AppNav() {
  const pathname = usePathname();
  const { role } = useRole();
  const sections = role === 'arbitrator' ? [...SECTIONS, ARBITRATION] : SECTIONS;
  const navRef = useRef<HTMLElement | null>(null);
  const [indicator, setIndicator] = useState<Indicator>(null);

  // Seçili sekmenin arkasındaki gösterge sekmeler arasında kayar; ölçü yol ve boyut değişince yenilenir.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
      setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
      active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [pathname, sections.length]);

  return (
    <nav
      ref={navRef}
      aria-label="App"
      className="relative -mx-1 flex gap-1 overflow-x-auto rounded-xl border border-border/70 bg-surface/50 p-1 text-sm backdrop-blur [scrollbar-width:none]"
    >
      {indicator && (
        <span
          aria-hidden="true"
          className="absolute top-1 bottom-1 rounded-lg bg-surface-muted shadow-[inset_0_-2px_0_0_var(--sq-accent)] transition-[left,width] duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)]"
          style={{ left: indicator.left, width: indicator.width }}
        />
      )}
      {sections.map((section) => {
        const current = pathname === section.href;
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={current ? 'page' : undefined}
            className={`relative shrink-0 rounded-lg px-3 py-1.5 whitespace-nowrap transition-colors ${
              current ? 'font-medium text-text' : 'text-muted hover:bg-surface-muted/50 hover:text-text'
            }`}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
