# Build bağlamı repo kökü: docker build --platform linux/amd64 -f apps/prover/Dockerfile .
# circom'un resmi ikilisi linux-amd64'tür. Release devresinin wasm'ı imajda derlenir; zkey ve manifest
# depodan (BC-20) gelir. Servis açılışta ikisinin SHA-256'sını manifest'le karşılaştırır.
FROM node:24-bookworm AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN circuits/payment-compliance/scripts/ci-build.sh
RUN pnpm install --frozen-lockfile --filter @squaresdk/solana-prover... \
    && pnpm --filter @squaresdk/solana-prover... build \
    && pnpm --filter @squaresdk/solana-prover deploy --prod --legacy /out \
    && mkdir /out/artifacts \
    && cp circuits/payment-compliance/build/payment_js/payment.wasm \
          circuits/payment-compliance/artifacts/payment.zkey \
          circuits/payment-compliance/artifacts/manifest.json /out/artifacts/

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production \
    PROVER_MANIFEST_PATH=/app/artifacts/manifest.json \
    PROVER_WASM_PATH=/app/artifacts/payment.wasm \
    PROVER_ZKEY_PATH=/app/artifacts/payment.zkey
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --no-create-home prover
WORKDIR /app
COPY --from=build --chown=prover:nodejs /out ./
USER prover
CMD ["node", "dist/index.js"]
