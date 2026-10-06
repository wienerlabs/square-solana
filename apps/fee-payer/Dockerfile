# Build bağlamı repo kökü: docker build -f apps/fee-payer/Dockerfile .
# Veritabanı migration'ları ve `programs` seed'i fee payer'dan önce db paketiyle uygulanır (README). Sponsor
# anahtarı imaja girmez; çalışma anında `FEE_PAYER_SECRET_KEY` gizli değişkeniyle verilir (ADR 0019).
FROM node:24-bookworm AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Kök paket turbo'yu getirir; turbo db'nin Prisma istemcisini (`generate`) derlemeden önce üretir.
RUN pnpm install --frozen-lockfile --filter . --filter @squaresdk/solana-fee-payer... \
    && pnpm turbo run build --filter=@squaresdk/solana-fee-payer... \
    && pnpm --filter @squaresdk/solana-fee-payer deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home feepayer
WORKDIR /app
COPY --from=build --chown=feepayer:nodejs /out ./
USER feepayer
CMD ["node", "dist/index.js"]
