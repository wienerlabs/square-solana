FROM rust:1.82-bookworm AS builder

# Install RISC Zero toolchain
RUN curl -L https://risczero.com/install | bash && \
    /root/.risc0/bin/rzup install

ENV PATH="/root/.risc0/bin:${PATH}"

WORKDIR /app

# Copy workspace files needed for build
COPY circuits/payment-prover/ circuits/payment-prover/
COPY services/prover-service/ services/prover-service/

WORKDIR /app/services/prover-service
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/services/prover-service/target/release/aperture-prover-service /usr/local/bin/aperture-prover-service

ENV PROVER_SERVICE_PORT=3003
EXPOSE 3003

CMD ["aperture-prover-service"]
