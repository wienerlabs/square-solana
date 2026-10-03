// Kontrast denetimi (FE-02): src/styles/theme.css'teki token'lar her iki temada WCAG 2.2'yi karşılar.
// Metin 1.4.3 (4.5:1), odak göstergesi ve UI bileşeni 1.4.11 (3:1). Değerler dosyadan okunur; bu
// testte kopyası yoktur.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COLOR_TOKENS } from '../src/styles/tokens';

const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} bloğu yok`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--sq-[a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]));
}

const themes = { light: block(':root'), dark: block("[data-theme='dark']") };

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const NON_TEXT = 3;
const surfaces = ['--sq-bg', '--sq-surface', '--sq-surface-muted'];
const tones = ['info', 'warning', 'success', 'danger', 'neutral'];

const pairs: [fg: string, bg: string, min: number][] = [
  ...surfaces.flatMap((bg) => [
    ['--sq-text', bg, TEXT] as [string, string, number],
    ['--sq-text-muted', bg, TEXT] as [string, string, number],
    ['--sq-link', bg, TEXT] as [string, string, number],
    ['--sq-danger-text', bg, TEXT] as [string, string, number],
    ['--sq-focus', bg, NON_TEXT] as [string, string, number],
  ]),
  ['--sq-on-accent', '--sq-accent', TEXT],
  ['--sq-on-accent', '--sq-accent-hover', TEXT],
  // StepIndicator: tamamlanan adım ters renkte, hatalı adım tehlike tonunda.
  ['--sq-surface', '--sq-text', TEXT],
  ['--sq-danger-text', '--sq-tone-danger-bg', TEXT],
  ...tones.map((t) => ['--sq-tone-fg', `--sq-tone-${t}-bg`, TEXT] as [string, string, number]),
];

describe.each(Object.entries(themes))('%s theme', (_name, tokens) => {
  it('defines the same tokens as the other theme', () => {
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(themes.light).sort());
  });

  it.each(pairs)('%s on %s ≥ %s:1', (fg, bg, min) => {
    expect(tokens[fg], fg).toMatch(/^#/);
    expect(tokens[bg], bg).toMatch(/^#/);
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(min);
  });
});

describe('token catalogue', () => {
  it('lists exactly the tokens theme.css defines', () => {
    expect(COLOR_TOKENS.map((t) => t.name).sort()).toEqual(Object.keys(themes.light).sort());
  });
});

describe('contrast()', () => {
  it('matches the WCAG reference values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});
