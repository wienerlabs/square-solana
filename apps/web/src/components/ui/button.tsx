import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'shine bg-accent text-on-accent shadow-[inset_0_1px_0_0_rgb(255_255_255/0.35),0_8px_24px_-12px_var(--sq-accent)] hover:bg-accent-hover hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.4),0_10px_28px_-10px_var(--sq-accent)]',
  secondary: 'border border-border bg-surface text-text shadow-sm hover:border-muted/40 hover:bg-surface-muted',
  ghost: 'text-text hover:bg-surface-muted',
  danger: 'border border-border bg-surface text-danger-text hover:bg-tone-danger-bg',
};

const SIZES: Record<ButtonSize, string> = {
  md: 'h-10 px-5 text-body',
  sm: 'h-8 px-3.5 text-caption',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** İşlem sürüyor: düğme devre dışı kalır ve yardımcı teknolojilere `aria-busy` bildirilir. */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      )}
      {children}
    </button>
  );
}
