mod adapters;
mod config;
mod context;
mod dlp;
mod grammar;
mod llama_client;
mod tool_filter;
mod logging;
mod openai;
mod profiles;
mod responses;
mod router;
mod upstream;

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use config::{AppState, ProxyConfigPayload};
use openai::{openai_error_response, ModelObject, ModelsListResponse};
use serde_json::Value;
use upstream::{
    build_http_client, forward_upstream_bytes, points_at_sidecar, MAX_BODY_BYTES,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::trace::TraceLayer;
use tracing::info;

const ADMIN_TOKEN_HEADER: &str = "x-llm-sidecar-admin-token";

#[derive(Clone)]
struct SharedState {
    inner: Arc<RwLock<AppState>>,
    client: reqwest::Client,
    admin_token: Option<String>,
}

fn stderr_uses_ansi() -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }
    std::io::IsTerminal::is_terminal(&std::io::stderr())
}

fn load_admin_token() -> Option<String> {
    std::env::var("LLM_SIDECAR_ADMIN_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn admin_authorized(headers: &HeaderMap, expected: &Option<String>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    headers
        .get(ADMIN_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|provided| provided == expected)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_ansi(stderr_uses_ansi())
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("LLM_SIDECAR_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3848);
    let payload = load_initial_payload();
    let app_state = AppState::from_payload(payload);
    let client = build_http_client().expect("http client");
    let admin_token = load_admin_token();
    if admin_token.is_none() {
        tracing::warn!("LLM_SIDECAR_ADMIN_TOKEN not set; /admin/reload is disabled");
    }

    let shared = SharedState {
        inner: Arc::new(RwLock::new(app_state)),
        client,
        admin_token,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/responses", post(responses))
        .route("/v1/completions", post(completions_pass_through))
        .route("/admin/reload", post(admin_reload))
        .layer(middleware::from_fn(logging::log_requests))
        .layer(TraceLayer::new_for_http())
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(shared);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("sidecar-proxy listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "service": "sidecar-proxy" }))
}

async fn list_models(State(state): State<SharedState>) -> impl IntoResponse {
    let guard = state.inner.read().await;
    let mut data = Vec::new();
    for ep in &guard.endpoints {
        for m in &ep.models {
            data.push(ModelObject {
                id: m.id.clone(),
                object: "model".into(),
                owned_by: ep.id.clone(),
            });
        }
    }
    Json(ModelsListResponse {
        object: "list".into(),
        data,
    })
}

async fn chat_completions(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let client_auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(err) => {
            return openai_error_response(
                StatusCode::BAD_REQUEST,
                format!("invalid JSON body: {err}"),
            )
        }
    };
    let model = value
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("(missing)");
    let stream = value
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);
    info!("chat/completions model={model} stream={stream}");
    let sidecar_port: u16 = std::env::var("LLM_SIDECAR_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3848);
    let snapshot = {
        let guard = state.inner.read().await;
        if let Some(ep) = guard.endpoints.first() {
            if points_at_sidecar(&ep.upstream_url, sidecar_port) {
                tracing::warn!(
                    "endpoint {:?} upstream_url points at this sidecar ({}); set upstream to your provider API, not the local proxy",
                    ep.id,
                    ep.upstream_url
                );
            }
        }
        guard.clone()
    };
    match router::route_chat(&snapshot, &state.client, client_auth, value).await {
        Ok(resp) => resp,
        Err(err) => openai_error_response(StatusCode::BAD_GATEWAY, err.to_string()),
    }
}

async fn responses(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let client_auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let value: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(err) => {
            return openai_error_response(
                StatusCode::BAD_REQUEST,
                format!("invalid JSON body: {err}"),
            )
        }
    };
    let snapshot = { state.inner.read().await.clone() };
    responses::route_responses(&snapshot, &state.client, client_auth, value).await
}

async fn completions_pass_through(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let snapshot = state.inner.read().await.clone();
    let upstream = snapshot
        .endpoints
        .first()
        .map(|e| e.upstream_url.replace("/chat/completions", "/completions"))
        .unwrap_or_else(|| "http://127.0.0.1/v1/completions".into());
    let client_auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let ep = snapshot.endpoints.first().cloned();
    let orchestrator = snapshot.orchestrator.clone();

    let ctx = adapters::AdapterContext {
        client: state.client.clone(),
        resolved: config::ResolvedEndpoint {
            endpoint: ep.clone().unwrap_or_else(|| config::EndpointConfig {
                id: "default".into(),
                display_name: None,
                upstream_url: upstream.clone(),
                adapter: "openai-pass-through".into(),
                tools_policy: "strip".into(),
                adapter_profile: None,
                api_key: None,
                models: vec![],
            }),
            profile: Default::default(),
        },
        orchestrator,
        app_state: snapshot,
        client_authorization: client_auth,
    };
    match forward_upstream_bytes(&ctx, &upstream, body).await {
        Ok(resp) => {
            let status = resp.status();
            let headers = resp.headers().clone();
            let bytes = resp.bytes().await.unwrap_or_default();
            upstream::upstream_response_to_axum(status, &headers, bytes)
        }
        Err(err) => openai_error_response(StatusCode::BAD_GATEWAY, err.to_string()),
    }
}

async fn admin_reload(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(payload): Json<ProxyConfigPayload>,
) -> impl IntoResponse {
    if !admin_authorized(&headers, &state.admin_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    let next = AppState::from_payload(payload);
    let mut guard = state.inner.write().await;
    *guard = next;
    Json(serde_json::json!({ "reloaded": true })).into_response()
}

fn load_initial_payload() -> ProxyConfigPayload {
    if let Ok(path) = std::env::var("LLM_SIDECAR_CONFIG_PATH") {
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(payload) => return payload,
                Err(err) => tracing::error!("invalid config at {path}: {err}"),
            },
            Err(err) => tracing::error!("failed to read config at {path}: {err}"),
        }
    }
    let config_json = std::env::var("LLM_SIDECAR_CONFIG").unwrap_or_else(|_| "{}".into());
    match serde_json::from_str(&config_json) {
        Ok(payload) => payload,
        Err(err) => {
            tracing::error!("invalid LLM_SIDECAR_CONFIG json: {err}");
            ProxyConfigPayload::default()
        }
    }
}
