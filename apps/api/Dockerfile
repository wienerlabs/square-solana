# Build bağlamı repo kökü: docker build -f apps/api/Dockerfile .
# Veritabanı migration'ları ve `programs` seed'i API'den önce db paketiyle uygulanır (README). OpenAPI belgesi
# derlemede sözleşmeden üretilir (dist/openapi.json).
FROM node:24-bookworm AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Kök paket turbo ve redocly'yi getirir; turbo db'nin Prisma istemcisini (`generate`) derlemeden önce üretir.
RUN pnpm install --frozen-lockfile --filter . --filter @squaresdk/solana-api... \
    && pnpm turbo run build --filter=@squaresdk/solana-api... \
    && pnpm --filter @squaresdk/solana-api deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home api
WORKDIR /app
COPY --from=build --chown=api:nodejs /out ./
USER api
CMD ["node", "dist/index.js"]
