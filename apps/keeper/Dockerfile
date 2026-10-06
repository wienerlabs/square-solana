# Build bağlamı repo kökü: docker build -f apps/keeper/Dockerfile .
# Veritabanı migration'ları ve `programs` seed'i keeper'dan önce db paketiyle uygulanır (README).
FROM node:24-bookworm AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Kök paket turbo'yu getirir; turbo db'nin Prisma istemcisini (`generate`) derlemeden önce üretir.
RUN pnpm install --frozen-lockfile --filter . --filter @squaresdk/solana-keeper... \
    && pnpm turbo run build --filter=@squaresdk/solana-keeper... \
    && pnpm --filter @squaresdk/solana-keeper deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home keeper
WORKDIR /app
COPY --from=build --chown=keeper:nodejs /out ./
USER keeper
CMD ["node", "dist/index.js"]
