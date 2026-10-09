'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useWebConfig } from '@/components/providers';
import { Address } from '@/components/ui/address';
import { CopyButton } from '@/components/ui/copy-button';
import { InstructionList } from '@/components/ui/instruction-list';
import { Reveal } from '@/components/ui/reveal';
import { StatusBadge } from '@/components/ui/status-badge';
import { FLOW_STEPS } from '@/lib/flow';
import {
  API_SNIPPET,
  APP_GUIDE,
  CLI_GROUPS,
  CLI_SNIPPET,
  DOC_SECTIONS,
  JOB_STATES,
  PROGRAM_DOCS,
  SDK_SNIPPET,
} from './content';

/** Okunan bölüm: ekranın üst kısmına en son giren başlığın bölümü (menüdeki vurgu). */
function useActiveSection(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0] ?? '');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        const first = ids.find((id) => visible.get(id));
        if (first) setActive(first);
      },
      { rootMargin: '-72px 0px -60% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Reveal as="section" id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 py-10 first:pt-0">
      <h2 id={`${id}-title`} className="text-heading-sm font-semibold tracking-tight">
        <a href={`#${id}`} className="group inline-flex items-center gap-2 hover:text-text">
          {title}
          <span aria-hidden="true" className="text-muted opacity-0 transition-opacity group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <div className="mt-4 grid gap-4 text-sm leading-relaxed text-muted">{children}</div>
    </Reveal>
  );
}

function Code({ value, label }: { value: string; label: string }) {
  return (
    <div className="card overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-caption text-muted">
        <span className="font-mono">{label}</span>
        <CopyButton value={value} label={`Copy the ${label} snippet`} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-caption leading-relaxed text-text">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-caption text-text">{children}</code>;
}

export function DocsPage() {
  const { cluster, programIds, apiUrl } = useWebConfig();
  const ids = DOC_SECTIONS.map((section) => section.id);
  const active = useActiveSection(ids);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="rise-in-self max-w-3xl">
        <p className="text-caption font-medium tracking-[0.14em] text-muted uppercase">Documentation</p>
        <h1 className="mt-2 text-heading font-semibold tracking-tight">
          <span className="text-gradient">Square docs</span>
        </h1>
        <p className="mt-4 text-subheading text-muted">
          How compliance-gated settlement works on Solana, how to use the app in every role, and how to build on it.
        </p>
      </header>

      <div className="mt-12 grid gap-10 lg:grid-cols-[13rem_1fr]">
        <nav aria-label="Docs" className="lg:sticky lg:top-24 lg:self-start">
          <ol className="flex gap-1 overflow-x-auto [scrollbar-width:none] lg:flex-col lg:border-l lg:border-border">
            {DOC_SECTIONS.map((section) => {
              const current = active === section.id;
              return (
                <li key={section.id} className="shrink-0">
                  <a
                    href={`#${section.id}`}
                    aria-current={current ? 'location' : undefined}
                    className={`relative block rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors lg:-ml-px lg:rounded-none lg:border-l-2 lg:py-1 lg:pl-4 ${
                      current
                        ? 'bg-surface-muted font-medium text-text lg:border-accent lg:bg-transparent'
                        : 'text-muted hover:text-text lg:border-transparent'
                    }`}
                  >
                    {section.title}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        <article className="min-w-0">
          <Section id="overview" title="Overview">
            <p>
              Square is compliance-gated settlement for autonomous agent work. An institution writes its spending
              mandate to the chain only as a salted Poseidon commitment and a public daily ceiling; the rules stay
              private. Registered agents (<Mono>did:aip</Mono>) accept and deliver jobs funded in USDC escrow.
            </p>
            <p>
              On a job under a policy no payment leaves escrow until the institution binds a Groth16 proof that this
              exact payment (payee, amount, mint, the day’s spending and the time) complies with the committed mandate.
              A refusing proof is valid too: it refunds the institution and names every rule that refused.
            </p>
            <p>
              This deployment runs on <Mono>{cluster}</Mono>. Every step is a Solana instruction you sign with your own
              wallet.
            </p>
          </Section>

          <Section id="programs" title="Programs">
            <p>
              Four Anchor programs in one workspace. Their addresses below come from this deployment’s configuration.
            </p>
            <ul className="grid gap-3 sm:grid-cols-2">
              {PROGRAM_DOCS.map((doc) => {
                const address = programIds[doc.name];
                return (
                  <li key={doc.name} className="card card-interactive flex flex-col gap-2 p-5">
                    <span className="font-mono text-sm text-text">{doc.program}</span>
                    <span>{doc.holds}</span>
                    <span className="text-caption">Written by: {doc.writers}</span>
                    {address ? (
                      <Address value={address} label={`${doc.program} address`} />
                    ) : (
                      <span>
                        <StatusBadge tone="neutral">Not configured</StatusBadge>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section id="flow" title="The eight steps">
            <p>
              Each step is an instruction. On a job under a policy the institution binds a pre-acceptance proof before
              the agent accepts (step 3), and the compliance proof (step 7) before the keeper finalizes (steps 6 and 8);
              without a proof the escrow waits.
            </p>
            <ol className="grid gap-2">
              {FLOW_STEPS.map((step) => (
                <li key={step.number} className="card grid gap-3 p-4 sm:grid-cols-[2rem_1fr] sm:gap-x-4">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-surface-muted font-mono text-caption text-text">
                    {step.number}
                  </span>
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-medium text-text">{step.title}</span>
                      <span className="text-caption">{step.actor}</span>
                    </div>
                    <p>{step.summary}</p>
                    <InstructionList instructions={step.instructions} label={`Step ${step.number} instructions`} />
                  </div>
                </li>
              ))}
            </ol>
            <p>
              The payment goes to the buyer when the receivable was sold, otherwise to the job’s agent wallet; the proof
              and the payout use the same rule.
            </p>
          </Section>

          <Section id="lifecycle" title="Job lifecycle">
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-sm">
                <caption className="sr-only">Job states</caption>
                <thead className="bg-surface-muted/60 text-left text-caption">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      State
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Meaning
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      In the vault
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {JOB_STATES.map((row) => (
                    <tr key={row.state} className="border-t border-border transition-colors hover:bg-surface-muted/50">
                      <td className="px-4 py-2.5 font-mono text-text">{row.state}</td>
                      <td className="px-4 py-2.5">{row.meaning}</td>
                      <td className="px-4 py-2.5">{row.vault}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="using-the-app" title="Using the app">
            <p>
              Connect a wallet, choose its role on the{' '}
              <Link href="/app" className="text-link underline">
                overview
              </Link>
              , and follow the steps for that role. Switch the wallet to act in another role.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {APP_GUIDE.map((guide) => (
                <div key={guide.role} className="card p-5">
                  <h3 className="text-sm font-semibold text-text">{guide.role}</h3>
                  <ol className="mt-3 grid list-decimal gap-2 pl-5 marker:text-muted">
                    {guide.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </Section>

          <Section id="compliance" title="Compliance">
            <ul className="grid list-disc gap-2 pl-5 marker:text-muted">
              <li>
                <span className="text-text">Screening.</span> The institution, the agent and the buyer need a clear,
                unexpired screening record. It is read when the job is funded, when a receivable is bought and at
                payout.
              </li>
              <li>
                <span className="text-text">Pre-acceptance proof.</span> Before the agent accepts, the institution
                proves that the job’s own terms (the whole amount, to the agent’s wallet, with an empty daily counter)
                break no permanent rule of its policy. After that a delivered job cannot be refused for good, except
                when the receivable is sold to a buyer on the policy’s blocked list.
              </li>
              <li>
                <span className="text-text">Release proof.</span> The circuit proves that the payment fits the mandate
                without revealing it. A proof is fresh only on its own UTC day and for the current daily counter; a
                stale proof is bound again.
              </li>
              <li>
                <span className="text-text">Travel Rule.</span> Above the escrow’s threshold, the institution binds a
                salted commitment of the Travel Rule record before funding. The record itself is stored encrypted by the
                Square API.
              </li>
            </ul>
          </Section>

          <Section id="disputes" title="Disputes">
            <ul className="grid list-disc gap-2 pl-5 marker:text-muted">
              <li>
                During the challenge window the institution can dispute a delivery with a bond of at least{' '}
                <Mono>max(amount × min_bond_bps / 10 000, min_bond_absolute)</Mono>.
              </li>
              <li>
                An M-of-N arbitrator panel votes. The first vote opens a proposal; the same decision approves it and a
                different one rejects it. When rejections make the threshold unreachable the proposal is dropped and the
                next vote opens a new one. Nobody votes twice on the same proposal.
              </li>
              <li>
                <Mono>execute_resolution</Mono> pays the decision. When the agent side receives nothing and its payee is
                flagged by screening, the bond also returns to the institution.
              </li>
              <li>
                A dispute without a decision by its deadline lapses: the bond is refunded and the job settles normally.
                If the institution never binds a proof, the agent can escalate without a bond after the proof timeout.
              </li>
            </ul>
          </Section>

          <Section id="fees" title="Fees and payouts">
            <p>
              Finalizing is permissionless: anyone can call it after the challenge window and earn the keeper fee,{' '}
              <Mono>amount × keeper_fee_bps / 10 000</Mono>; the payee receives the rest. Every settlement writes the
              agent’s reputation, even when a buyer was paid, and a validation record that keeps the outcome.
            </p>
          </Section>

          <Section id="identity" title="Agent identity">
            <p>
              An agent record is a DID:{' '}
              <Mono>did:aip:2:solana:&lt;chain-ref&gt;:&lt;registry&gt;:&lt;AgentRecord&gt;</Mono>. It resolves from the
              chain; the agent card counts as verified only when its SHA-256 equals the hash on chain. Resolve any DID
              on the{' '}
              <Link href="/app/did" className="text-link underline">
                Resolve DID
              </Link>{' '}
              page.
            </p>
          </Section>

          <Section id="developers" title="For developers">
            <p>
              The TypeScript packages live in the Square monorepo: <Mono>@squaresdk/solana-sdk</Mono> (typed clients,
              PDAs, transaction builders for all eight steps, event decoding and the REST client),{' '}
              <Mono>@squaresdk/solana-policy</Mono> (commitments, buyer trees and proofs) and{' '}
              <Mono>@squaresdk/solana-agent-sdk</Mono> (building an agent).
            </p>
            <Code label="sdk.ts" value={SDK_SNIPPET} />
            <p>
              The HTTP API answers every <Mono>/v1</Mono> call with a <Mono>{'{ success, data, error, meta }'}</Mono>{' '}
              envelope; the SDK methods are the OpenAPI operation ids.{' '}
              {apiUrl ? (
                <>
                  This deployment’s contract:{' '}
                  <a href={`${apiUrl}/openapi.json`} className="text-link underline">
                    {apiUrl}/openapi.json
                  </a>
                  . API keys are created on the{' '}
                  <Link href="/app/developers" className="text-link underline">
                    Developers
                  </Link>{' '}
                  page.
                </>
              ) : (
                'This deployment has no Square API configured.'
              )}
            </p>
            <Code label="api.ts" value={API_SNIPPET} />
            <p>
              The command line, <Mono>squaresdk-solana</Mono>, runs the same steps from a terminal with JSON output:
            </p>
            <Code label="terminal" value={CLI_SNIPPET} />
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-sm">
                <caption className="sr-only">CLI command groups</caption>
                <tbody>
                  {CLI_GROUPS.map((row) => (
                    <tr key={row.group} className="border-t border-border first:border-t-0">
                      <th scope="row" className="px-4 py-2.5 text-left font-mono font-medium text-text">
                        {row.group}
                      </th>
                      <td className="px-4 py-2.5 font-mono text-caption">{row.actions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </article>
      </div>
    </main>
  );
}
