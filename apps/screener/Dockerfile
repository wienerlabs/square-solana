# Build bağlamı repo kökü: docker build -f apps/screener/Dockerfile .
# Veritabanı migration'ları ve `programs` seed'i screener'dan önce db paketiyle uygulanır (README). Screener
# authority anahtarı imaja girmez: çalışma anında secret store'dan gelir (README "Anahtar saklama").
FROM node:24-bookworm AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Kök paket turbo'yu getirir; turbo db'nin Prisma istemcisini (`generate`) derlemeden önce üretir.
RUN pnpm install --frozen-lockfile --filter . --filter @squaresdk/solana-screener... \
    && pnpm turbo run build --filter=@squaresdk/solana-screener... \
    && pnpm --filter @squaresdk/solana-screener deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home screener
WORKDIR /app
COPY --from=build --chown=screener:nodejs /out ./
USER screener
CMD ["node", "dist/index.js"]
