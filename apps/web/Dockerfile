# Build bağlamı repo kökü: docker build -f apps/web/Dockerfile .
# Railway: servisin Root Directory'si boş (repo kökü), Railway Config File /apps/web/railway.json (ADR 0002).
# Yapılandırma (SQUARE_SOLANA_CLUSTER, SQUARE_SOLANA_RPC_URL) imaja girmez; istek anında okunur.
FROM node:24-bookworm AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @squaresdk/solana-web... \
    && pnpm --filter @squaresdk/solana-web... build

FROM node:24-bookworm-slim AS runner
# HOSTNAME: standalone sunucu buna bağlanır; Docker'ın verdiği container adı yerine bütün arayüzler.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home web
WORKDIR /app
# Next'in standalone çıktısı: sunucunun izlenen dosyaları ve (build betiğinin kopyaladığı) statik varlıklar.
COPY --from=build --chown=web:nodejs /repo/apps/web/.next/standalone ./
USER web
# Sunucu PORT'u ortamdan okur (Railway verir); yoksa 3000.
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
