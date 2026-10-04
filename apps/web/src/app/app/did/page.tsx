import type { Metadata } from 'next';
import { DidResolver } from '@/components/did/did-resolver';

export const metadata: Metadata = { title: 'Resolve a DID' };

export default async function Page({ searchParams }: { searchParams: Promise<{ did?: string | string[] }> }) {
  const { did } = await searchParams;
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Resolve a DID</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Reads the agent record from the connected network and checks the agent card against the hash on chain. Nothing
        is looked up on a Square server.
      </p>
      <div className="mt-6">
        <DidResolver initialDid={typeof did === 'string' ? did : ''} />
      </div>
    </main>
  );
}
