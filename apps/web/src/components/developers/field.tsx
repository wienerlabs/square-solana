import { useId, type ReactNode } from 'react';

export const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text aria-invalid:border-danger-text';

export const panelClass = 'rounded-card border border-border bg-surface p-6';
export const headingClass = 'text-sm font-medium uppercase tracking-wide text-muted';

/** Etiketli form alanı: ipucu ve hata `aria-describedby` ile bağlanır. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-caption text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

/** Hata satırı: ekran okuyucuya hemen bildirilir. */
export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-danger-text">
      {children}
    </p>
  );
}
