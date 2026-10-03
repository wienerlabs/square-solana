import { PILLARS } from './content';

export function Pillars() {
  return (
    <section aria-labelledby="pillars-title" className="py-12">
      <h2 id="pillars-title" className="text-heading-sm font-semibold">
        What Square does
      </h2>
      <ul className="mt-6 grid gap-4 md:grid-cols-3">
        {PILLARS.map((pillar) => (
          <li key={pillar.title} className="rounded-card border border-border bg-surface p-6">
            <h3 className="text-subheading font-semibold">{pillar.title}</h3>
            <p className="mt-2 text-sm text-muted">{pillar.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
