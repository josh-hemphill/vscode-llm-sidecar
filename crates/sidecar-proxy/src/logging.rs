use axum::{
    extract::Request,
    middleware::Next,
    response::Response,
};
use tracing::info;

/// Logs each HTTP request at info level (visible with default RUST_LOG=info).
pub async fn log_requests(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    info!("{method} {path} -> {status}");
    if status == 404 && path.starts_with("/v1/") {
        info!(
            "client received HTTP 404 for {path}; if using LLM Sidecar this is usually the upstream provider URL or model id — check the upstream= log lines above"
        );
    }
    response
}
