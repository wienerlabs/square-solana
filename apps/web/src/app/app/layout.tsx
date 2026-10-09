import type { ReactNode } from 'react';
import { AppNav } from '@/components/app-nav';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <AppNav />
      {/* Yol değişince içerik yeniden bağlanır; açılış animasyonu her sayfada çalışır. */}
      <div className="rise-in mt-8">{children}</div>
    </div>
  );
}
