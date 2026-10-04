import type { Metadata } from 'next';
import { PolicyPage } from '@/components/policy/policy-page';

export const metadata: Metadata = { title: 'Policy' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Spending policy</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Write the rules every release must satisfy. The rules stay private: the chain only receives a salted commitment,
        the public daily ceiling and the root of the approved buyers.
      </p>
      <div className="mt-6">
        <PolicyPage />
      </div>
    </main>
  );
}
