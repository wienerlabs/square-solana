import type { Metadata } from 'next';
import { AccountPage } from '@/components/account/account-page';

export const metadata: Metadata = { title: 'Account' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Account</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Choose who pays for this wallet&apos;s transactions and whom each role acts as: the wallet itself, or a Squads
        smart account whose vault holds the role on chain while the sponsor pays the fees.
      </p>
      <div className="mt-6">
        <AccountPage />
      </div>
    </main>
  );
}
