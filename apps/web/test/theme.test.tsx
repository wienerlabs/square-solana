// @vitest-environment jsdom
// Tema geçişi: seçim <html data-theme>'e yazılır, kalıcıdır ve basılı düğme yardımcı teknolojiye bildirilir.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, ThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';

const mount = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(cleanup);

describe('ThemeToggle', () => {
  it('starts on the system preference', () => {
    mount();
    expect(screen.getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true');
    // jsdom'un sistem tercihi açık (matchMedia eşleşmez).
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('switches to dark and back, and remembers the choice', () => {
    mount();
    act(() => screen.getByRole('button', { name: 'Dark' }).click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('false');

    act(() => screen.getByRole('button', { name: 'Light' }).click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('restores a stored choice on load', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    mount();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
  });
});
