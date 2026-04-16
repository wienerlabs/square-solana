use actix_cors::Cors;
use actix_web::{middleware, web, App, HttpResponse, HttpServer};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tracing::{error, info};

mod openapi;
mod prover;

#[derive(Debug, Deserialize)]
pub struct ProveRequest {
    pub policy_id: String,
    pub operator_id: String,
    pub max_daily_spend_lamports: u64,
    pub max_per_transaction_lamports: u64,
    pub allowed_endpoint_categories: Vec<String>,
    pub blocked_addresses: Vec<String>,
    pub token_whitelist: Vec<String>,
    pub payment_amount_lamports: u64,
    pub payment_token_mint: String,
    pub payment_recipient: String,
    pub payment_endpoint_category: String,
    pub payment_timestamp: String,
    pub daily_spent_so_far_lamports: u64,
}

#[derive(Debug, Serialize)]
pub struct ProveResponse {
    pub is_compliant: bool,
    pub proof_hash: String,
    pub amount_range_min: u64,
    pub amount_range_max: u64,
    pub verification_timestamp: String,
    pub journal_digest: String,
    pub receipt_bytes: Vec<u8>,
    pub image_id: [u32; 8],
    pub proving_time_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub version: String,
}

async fn health() -> HttpResponse {
    HttpResponse::Ok().json(HealthResponse {
        status: "healthy".to_string(),
        service: "aperture-prover-service".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

async fn prove(body: web::Json<ProveRequest>) -> HttpResponse {
    let start = Instant::now();

    info!(
        operator_id = %body.operator_id,
        policy_id = %body.policy_id,
        amount = body.payment_amount_lamports,
        "Received proof request"
    );

    let input = aperture_payment_prover_core::ProverInput {
        policy_id: body.policy_id.clone(),
        operator_id: body.operator_id.clone(),
        max_daily_spend_lamports: body.max_daily_spend_lamports,
        max_per_transaction_lamports: body.max_per_transaction_lamports,
        allowed_endpoint_categories: body.allowed_endpoint_categories.clone(),
        blocked_addresses: body.blocked_addresses.clone(),
        time_restrictions: vec![],
        token_whitelist: body.token_whitelist.clone(),
        payment_amount_lamports: body.payment_amount_lamports,
        payment_token_mint: body.payment_token_mint.clone(),
        payment_recipient: body.payment_recipient.clone(),
        payment_endpoint_category: body.payment_endpoint_category.clone(),
        payment_timestamp: body.payment_timestamp.clone(),
        daily_spent_so_far_lamports: body.daily_spent_so_far_lamports,
    };

    match prover::generate_proof(input).await {
        Ok(result) => {
            let proving_time = start.elapsed().as_millis() as u64;
            info!(
                proving_time_ms = proving_time,
                is_compliant = result.output.is_compliant,
                "Proof generated successfully"
            );

            HttpResponse::Ok().json(ProveResponse {
                is_compliant: result.output.is_compliant,
                proof_hash: result.output.proof_hash,
                amount_range_min: result.output.amount_range_min,
                amount_range_max: result.output.amount_range_max,
                verification_timestamp: result.output.verification_timestamp,
                journal_digest: result.output.journal_digest,
                receipt_bytes: result.receipt_bytes,
                image_id: result.image_id,
                proving_time_ms: proving_time,
            })
        }
        Err(e) => {
            error!(error = ?e, error_chain = %format!("{e:#}"), "Proof generation failed");
            HttpResponse::InternalServerError().json(ErrorResponse {
                error: format!("Proof generation failed: {e:#}"),
            })
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let port: u16 = std::env::var("PROVER_SERVICE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3003);

    info!(port = port, "Starting Aperture Prover Service");

    HttpServer::new(|| {
        let cors = Cors::default()
            .allow_any_origin()
            .allow_any_method()
            .allow_any_header()
            .max_age(3600);

        App::new()
            .wrap(cors)
            .wrap(middleware::Logger::default())
            .route("/health", web::get().to(health))
            .route("/api-docs.json", web::get().to(openapi::openapi_json))
            .route("/prove", web::post().to(prove))
    })
    .bind(("0.0.0.0", port))?
    .run()
    .await
}
