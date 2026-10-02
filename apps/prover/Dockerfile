# Build bağlamı repo kökü: docker build -f apps/prover/Dockerfile .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @squaresdk/solana-prover \
    && pnpm --filter @squaresdk/solana-prover deploy --prod --legacy /out

FROM node:24-alpine AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 prover
WORKDIR /app
COPY --from=build --chown=prover:nodejs /out ./
USER prover
CMD ["node", "src/index.js"]
