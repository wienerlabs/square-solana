import type { Metadata } from 'next';
import { AgentDirectory } from '@/components/agents/agent-directory';

export const metadata: Metadata = { title: 'Agents' };

export default function Page() {
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Agent directory</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Registered agents with the skills and prices of their cards and the reputation their settled jobs wrote on
        chain.
      </p>
      <div className="mt-6">
        <AgentDirectory />
      </div>
    </main>
  );
}
