// Panellerin ve ağ sayfasının ortak parçaları (FE-11).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { shorten } from '@/components/ui/address';
import { formatUnits, type SettlementToken } from '@/lib/settlement';

export type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

export const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function Notice({ children }: { children: ReactNode }) {
  return <p className="card p-6 text-sm text-muted">{children}</p>;
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">{title}</h2>
        {actions}
      </div>
      {description && <p className="mt-2 max-w-3xl text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

/** Özet sayı: etiket, değer ve isteğe bağlı açıklama. */
export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="rounded-card border border-border p-4">
      <dt className="text-caption text-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
      {detail && <dd className="mt-1 text-caption text-muted">{detail}</dd>}
    </div>
  );
}

/** Sayı ve adı, tekil ya da çoğul: `counted(1, 'job')` → "1 job", `counted(3, 'job')` → "3 jobs". */
export const counted = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;

/** Settlement mint'indeki tutar USDC olarak; token henüz okunmadıysa taban birimi. */
export function usdcFormatter(token: SettlementToken | null) {
  return (base: bigint) => (token ? `${formatUnits(base, token.decimals)} USDC` : `${base} base units`);
}

/** Uygulama içi sayfaya giden kısaltılmış adres; tam adres ekran okuyucuya ve `title`'a gider. */
export function AddressLink({ href, address, label }: { href: string; address: string; label: string }) {
  return (
    <Link href={href} className="font-mono text-link underline" title={address}>
      <span aria-hidden="true">{shorten(address)}</span>
      <span className="sr-only">
        {label} {address}
      </span>
    </Link>
  );
}
