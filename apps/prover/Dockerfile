FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY services/prover-service/package.json services/prover-service/package-lock.json* ./
RUN npm install --omit=dev

FROM base AS runner
ENV NODE_ENV=production
ENV PROVER_SERVICE_PORT=3003

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 prover

COPY --from=deps --chown=prover:nodejs /app/node_modules ./node_modules
COPY --chown=prover:nodejs services/prover-service/src ./src
COPY --chown=prover:nodejs services/prover-service/artifacts ./artifacts
COPY --chown=prover:nodejs services/prover-service/package.json ./package.json

USER prover
EXPOSE 3003

CMD ["node", "src/index.js"]
