'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import type { Stripe, StripeCardElement } from '@stripe/stripe-js';
import { cardStyle, stripeFor } from '@/lib/stripe';

export interface CardInput {
  stripe: Stripe;
  card: StripeCardElement;
}

/**
 * Stripe'ın kart alanı (Card Element, FE-20). Kart numarası Stripe'ın çerçevesinde girilir ve yalnızca Stripe'a gider;
 * alan tamamlandığında `onInput` Stripe istemcisini ve alanı verir (onaylama `confirmCardPayment` /
 * `confirmCardSetup` ile), tamamlanmadıysa null.
 */
export function CardField({
  publishableKey,
  label,
  hint,
  disabled,
  onInput,
}: {
  publishableKey: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  onInput(input: CardInput | null): void;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const element = useRef<StripeCardElement | null>(null);
  const report = useRef(onInput);
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }>({
    kind: 'loading',
  });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    report.current = onInput;
  }, [onInput]);

  useEffect(() => {
    let active = true;
    let card: StripeCardElement | null = null;
    stripeFor(publishableKey).then(
      (stripe) => {
        if (!active || !container.current) return;
        card = stripe.elements().create('card', { style: cardStyle(container.current) });
        element.current = card;
        card.on('change', (event) => {
          setProblem(event.error?.message ?? null);
          report.current(event.complete ? { stripe, card: card! } : null);
        });
        card.on('ready', () => active && setState({ kind: 'ready' }));
        card.mount(container.current);
      },
      (error: Error) => active && setState({ kind: 'error', message: error.message }),
    );
    return () => {
      active = false;
      element.current = null;
      card?.destroy();
      report.current(null);
    };
  }, [publishableKey]);

  // Tema değişince alanın renkleri yeniden okunur.
  useEffect(() => {
    if (element.current && container.current) element.current.update({ style: cardStyle(container.current) });
  }, [resolvedTheme]);

  useEffect(() => {
    element.current?.update({ disabled: Boolean(disabled) });
  }, [disabled, state.kind]);

  const describedBy = [hint && `${id}-hint`, problem && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className="text-sm font-medium">
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        aria-busy={state.kind === 'loading'}
        className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-text"
      >
        <div ref={container} />
        {state.kind === 'loading' && <span className="text-caption text-muted">Loading Stripe&apos;s card form…</span>}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      )}
      {problem && (
        <p id={`${id}-error`} className="text-caption text-danger-text">
          {problem}
        </p>
      )}
      {state.kind === 'error' && <p className="text-sm text-danger-text">{state.message}</p>}
    </div>
  );
}
