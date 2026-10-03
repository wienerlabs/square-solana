# Build bağlamı repo kökü: docker build -f apps/compliance-api/Dockerfile .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @squaresdk/solana-compliance-api \
    && pnpm --filter @squaresdk/solana-compliance-api build \
    && pnpm --filter @squaresdk/solana-compliance-api deploy --prod --legacy /out

FROM node:24-alpine AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser
WORKDIR /app
COPY --from=build --chown=appuser:nodejs /out ./
USER appuser
CMD ["sh", "-c", "node dist/migrations/run.js && exec node dist/index.js"]
