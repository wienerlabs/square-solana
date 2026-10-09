'use client';

import { useEffect } from 'react';

/**
 * Kartların imleci izleyen ışığı (globals.css `.card::after`): fare hangi kartın üzerindeyse onun `--mx` / `--my`
 * değişkenlerine imlecin karta göre konumunu yazar. Tek bir dinleyici bütün kartlara yeter; dokunmatik ve hareketi
 * azaltmış kullanıcıda çalışmaz.
 */
export function CardSpotlight() {
  useEffect(() => {
    const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (!fine || reduced) return;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      const card = (event.target as Element | null)?.closest?.('.card') as HTMLElement | null;
      if (!card) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${event.clientX - box.left}px`);
        card.style.setProperty('--my', `${event.clientY - box.top}px`);
      });
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onMove);
    };
  }, []);
  return null;
}
