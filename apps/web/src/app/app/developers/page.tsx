import type { Metadata } from 'next';
import { DevelopersPage } from '@/components/developers/developers-page';

export const metadata: Metadata = { title: 'Developers' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Developers</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Self-service access to the Square API: create and revoke API keys, charge for your own endpoints with x402 and
        see what they earn, and copy TypeScript snippets for the SDK.
      </p>
      <div className="mt-6">
        <DevelopersPage />
      </div>
    </main>
  );
}
