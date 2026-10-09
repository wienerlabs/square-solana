/** Zincir talimatları: her biri ayrı, okunaklı bir rozet; sığmayan alt satıra geçer. */
export function InstructionList({ instructions, label }: { instructions: readonly string[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1.5">
      {instructions.map((instruction) => (
        <li
          key={instruction}
          className="rounded-md border border-border bg-surface-muted/70 px-2 py-0.5 font-mono text-[11px] leading-5 text-text/80"
        >
          {instruction}
        </li>
      ))}
    </ul>
  );
}
