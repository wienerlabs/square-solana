import path from 'node:path';
import type { NextConfig } from 'next';

// Ağ ve RPC yapılandırması çalışma anında sunucuda okunur (src/lib/config.ts); derlemeye gömülmez.
// `standalone`: dağıtım yalnızca sunucunun kullandığı dosyaları taşır (Railway imajı, ADR 0002). İzleme kökü
// monorepo köküdür; pnpm workspace bağımlılıkları buradan çözülür.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
};

export default nextConfig;
