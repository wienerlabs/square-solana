'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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

export function AppNav() {
  const pathname = usePathname();
  const { role } = useRole();
  const sections = role === 'arbitrator' ? [...SECTIONS, ARBITRATION] : SECTIONS;
  return (
    <nav aria-label="App" className="flex flex-wrap gap-1 text-sm">
      {sections.map((section) => {
        const current = pathname === section.href;
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={current ? 'page' : undefined}
            className={`rounded-full px-3 py-1.5 ${current ? 'bg-surface-muted font-medium text-text' : 'text-muted hover:text-text'}`}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
