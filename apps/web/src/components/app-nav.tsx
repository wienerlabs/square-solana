'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECTIONS = [
  { href: '/app', label: 'Overview' },
  { href: '/app/policy', label: 'Policy' },
  { href: '/app/agent', label: 'Agent' },
  { href: '/app/agents', label: 'Directory' },
  { href: '/app/jobs/new', label: 'New job' },
  { href: '/app/claims', label: 'Receivables' },
  { href: '/app/did', label: 'Resolve DID' },
] as const;

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="App" className="flex gap-1 text-sm">
      {SECTIONS.map((section) => {
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
