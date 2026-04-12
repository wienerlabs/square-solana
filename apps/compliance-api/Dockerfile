FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
COPY shared/types/package.json shared/types/
COPY services/compliance-api/package.json services/compliance-api/
RUN npm install --workspace=@aperture/types --workspace=@aperture/compliance-api

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY tsconfig.base.json ./
COPY shared/types/ shared/types/
COPY services/compliance-api/ services/compliance-api/
RUN rm -f shared/types/tsconfig.tsbuildinfo && \
    npm run build --workspace=@aperture/types && \
    npm run build --workspace=@aperture/compliance-api

FROM base AS runner
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 appuser
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared/types/dist ./shared/types/dist
COPY --from=builder /app/shared/types/package.json ./shared/types/package.json
COPY --from=builder /app/services/compliance-api/dist ./services/compliance-api/dist
COPY --from=builder /app/services/compliance-api/package.json ./services/compliance-api/package.json
COPY --from=deps /app/package.json ./package.json

USER appuser
WORKDIR /app/services/compliance-api
EXPOSE 3002
CMD ["node", "dist/index.js"]
