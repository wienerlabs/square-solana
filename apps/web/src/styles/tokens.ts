// Bileşen kataloğunda gösterilen anlamsal token'lar. test/contrast.test.ts bu listenin
// src/styles/theme.css'teki token'larla birebir aynı olduğunu denetler.
export const COLOR_TOKENS = [
  { name: '--sq-bg', use: 'Page background' },
  { name: '--sq-surface', use: 'Cards and panels' },
  { name: '--sq-surface-muted', use: 'Table headers, hover' },
  { name: '--sq-border', use: 'Borders and dividers' },
  { name: '--sq-text', use: 'Body text' },
  { name: '--sq-text-muted', use: 'Secondary text' },
  { name: '--sq-accent', use: 'Primary action' },
  { name: '--sq-accent-hover', use: 'Primary action, hover' },
  { name: '--sq-on-accent', use: 'Text on the accent' },
  { name: '--sq-link', use: 'Links' },
  { name: '--sq-focus', use: 'Focus indicator' },
  { name: '--sq-danger-text', use: 'Errors' },
  { name: '--sq-tone-fg', use: 'Badge text' },
  { name: '--sq-tone-info-bg', use: 'Info badge' },
  { name: '--sq-tone-info-dot', use: 'Info dot' },
  { name: '--sq-tone-warning-bg', use: 'Warning badge' },
  { name: '--sq-tone-warning-dot', use: 'Warning dot' },
  { name: '--sq-tone-success-bg', use: 'Success badge' },
  { name: '--sq-tone-success-dot', use: 'Success dot' },
  { name: '--sq-tone-danger-bg', use: 'Danger badge' },
  { name: '--sq-tone-danger-dot', use: 'Danger dot' },
  { name: '--sq-tone-neutral-bg', use: 'Neutral badge' },
  { name: '--sq-tone-neutral-dot', use: 'Neutral dot' },
] as const;

export const TEXT_STYLES = [
  { name: 'Display', className: 'text-display', size: '60 px' },
  { name: 'Heading', className: 'text-heading', size: '36 px' },
  { name: 'Heading small', className: 'text-heading-sm', size: '24 px' },
  { name: 'Subheading', className: 'text-subheading', size: '18 px' },
  { name: 'Body', className: 'text-body', size: '16 px' },
  { name: 'Caption', className: 'text-caption', size: '12 px' },
] as const;
