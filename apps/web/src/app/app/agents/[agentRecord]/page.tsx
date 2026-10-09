import type { Metadata } from 'next';
import { AgentProfileView } from '@/components/agents/agent-profile';
import { isAddress } from '@/lib/config';

export const metadata: Metadata = { title: 'Agent' };

export default async function Page({ params }: { params: Promise<{ agentRecord: string }> }) {
  const { agentRecord } = await params;
  return (
    <main className="mt-6">
      <h1 className="text-heading-sm font-semibold">Agent</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        The agent&apos;s record and card, the reputation its settled jobs wrote on chain, its validation history and its
        jobs.
      </p>
      <div className="mt-6">
        {isAddress(agentRecord) ? (
          <AgentProfileView agentRecord={agentRecord} />
        ) : (
          <p className="card p-6 text-sm text-muted">This is not an agent record address.</p>
        )}
      </div>
    </main>
  );
}
