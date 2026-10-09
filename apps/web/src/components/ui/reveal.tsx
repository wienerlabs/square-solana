'use client';

import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react';

type RevealState = 'pending' | 'shown';

/**
 * Kaydırınca belirme: öğe görünür alana girince soluk ve aşağıdan yerine oturur (globals.css `[data-reveal]`).
 * Hareketi azaltmış kullanıcıda ya da IntersectionObserver olmayan ortamda (test, eski tarayıcı) içerik baştan
 * görünür. İlk çizimde içerik görünür kalır; gizleme yalnızca istemci hazırsa ve öğe ekranın altındaysa başlar,
 * böylece ekranda olan içerik hiç kaybolmaz.
 */
export function Reveal({
  as: Tag = 'div',
  delay = 0,
  className,
  children,
  ...rest
}: {
  as?: ElementType;
  /** Belirmenin gecikmesi (ms); listelerde sıralı görünüm için. */
  delay?: number;
  className?: string;
  children: ReactNode;
} & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<RevealState | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduced || typeof IntersectionObserver === 'undefined') return;
    const below = element.getBoundingClientRect().top > window.innerHeight * 0.92;
    if (!below) return;
    setState('pending');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState('shown');
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const style = { '--reveal-delay': `${delay}ms` } as CSSProperties;
  return (
    <Tag ref={ref} data-reveal={state ?? undefined} style={style} className={className} {...rest}>
      {children}
    </Tag>
  );
}
