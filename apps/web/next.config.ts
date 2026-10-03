import type { NextConfig } from 'next';

// Ağ ve RPC yapılandırması çalışma anında sunucuda okunur (src/lib/config.ts); derlemeye gömülmez.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
