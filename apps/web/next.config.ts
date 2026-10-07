import path from 'node:path';
import type { NextConfig } from 'next';

// Ağ ve RPC yapılandırması çalışma anında sunucuda okunur (src/lib/config.ts); derlemeye gömülmez.
// `standalone`: dağıtım yalnızca sunucunun kullandığı dosyaları taşır (Railway imajı, ADR 0002). İzleme kökü
// monorepo köküdür; pnpm workspace bağımlılıkları buradan çözülür.
// Güvenlik başlıkları (BE-32): uygulama cüzdan imzası alır; başka bir sitenin çerçevesine konamaz (clickjacking),
// tipi koklanmaz, HTTPS'te kalır. CSP yalnızca çerçeve, `<base>`, eklenti ve form hedeflerini kısar: Next'in satır
// içi betikleri ve cüzdan bağdaştırıcıları betik kaynağını sabitlemeyi bozar. `payment` izni açık kalır: Stripe
// Elements'in cüzdanla ödemesi (FE-20) onu ister.
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: [...SECURITY_HEADERS] }];
  },
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
};

export default nextConfig;
