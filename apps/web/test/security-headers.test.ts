// Güvenlik başlıkları (BE-32): her yolda çerçeveleme yasak, tip koklanmaz, HTTPS zorunlu.
import { describe, expect, it } from 'vitest';
import nextConfig, { SECURITY_HEADERS } from '../next.config';

describe('güvenlik başlıkları', () => {
  it('her yola uygulanır; çerçeveleme ve tip koklama kapalı', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: '/:path*', headers: [...SECURITY_HEADERS] }]);
    const byName = Object.fromEntries(SECURITY_HEADERS.map(({ key, value }) => [key, value]));
    expect(byName['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(byName['X-Frame-Options']).toBe('DENY');
    expect(byName['X-Content-Type-Options']).toBe('nosniff');
    expect(byName['Strict-Transport-Security']).toMatch(/^max-age=\d+/);
  });
});
