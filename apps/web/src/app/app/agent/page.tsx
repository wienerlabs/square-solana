import type { Metadata } from 'next';
import { AgentPage } from '@/components/agent/agent-page';

export const metadata: Metadata = { title: 'Agent' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Register an agent</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        The agent gets a did:aip identity derived from its record on Solana. The record points to the agent card and
        holds its SHA-256, so anyone resolving the DID can check that the card has not changed.
      </p>
      <div className="mt-6">
        <AgentPage />
      </div>
    </main>
  );
}
