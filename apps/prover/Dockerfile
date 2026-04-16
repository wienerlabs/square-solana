FROM rust:1.94-bookworm AS builder

# Install rzup itself (small, fast)
RUN curl -L https://risczero.com/install | bash

ENV PATH="/root/.risc0/bin:${PATH}"

# Install RISC Zero components separately so a failed/slow download can be retried
# without rebuilding successful layers. Each component gets its own cache layer.
RUN rzup install rust
RUN rzup install cargo-risczero
RUN rzup install r0vm 1.2.6
RUN rzup install cpp

WORKDIR /app

# Copy workspace files needed for build
COPY circuits/payment-prover/ circuits/payment-prover/
COPY services/prover-service/ services/prover-service/

WORKDIR /app/services/prover-service
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 wget && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/services/prover-service/target/release/aperture-prover-service /usr/local/bin/aperture-prover-service
COPY --from=builder /root/.risc0/extensions/v1.2.6-cargo-risczero-x86_64-unknown-linux-gnu/r0vm /usr/local/bin/r0vm

ENV PROVER_SERVICE_PORT=3003
EXPOSE 3003

CMD ["aperture-prover-service"]
