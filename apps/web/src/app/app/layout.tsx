import type { ReactNode } from 'react';
import { AppNav } from '@/components/app-nav';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <AppNav />
      {children}
    </div>
  );
}
