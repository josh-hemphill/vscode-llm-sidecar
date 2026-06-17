use crate::adapters::{apply_upstream_auth, AdapterContext, AdapterError};
use crate::config::AppState;
use crate::dlp::redact_value;
use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use reqwest::Client;
use serde_json::Value;
use tracing::warn;

const CHAT_COMPLETIONS_SUFFIX: &str = "/chat/completions";

pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_SSE_BUFFER_BYTES: usize = 16 * 1024 * 1024;

/// Builds a shared HTTP client with connect and request timeouts.
pub fn build_http_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(300))
        .build()
}

/// Returns true when the URL targets loopback llama-server.
pub fn is_loopback_llama_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1")
}

/// Checks egress policy for outbound URLs (upstream and llama).
pub fn ensure_egress_allowed(state: &AppState, url: &str, is_llama: bool) -> Result<(), AdapterError> {
    if is_llama {
        if state.orchestrator.local_only && !is_loopback_llama_url(url) {
            return Err(AdapterError::Other(
                "local-only mode requires llama-server on loopback".into(),
            ));
        }
        return Ok(());
    }
    if !state.is_egress_allowed(url) {
        return Err(AdapterError::Other(
            "egress blocked by local-only mode or allowlist".into(),
        ));
    }
    Ok(())
}

/// Applies DLP redaction to JSON outbound bodies.
pub fn redact_outbound_json(value: &Value) -> Value {
    redact_value(value)
}

/// Forwards a JSON body upstream with egress and DLP enforcement.
pub async fn forward_upstream_json(
    ctx: &AdapterContext,
    upstream_url: &str,
    body: &Value,
) -> Result<reqwest::Response, AdapterError> {
    ensure_egress_allowed(&ctx.app_state, upstream_url, false)?;
    let payload = redact_outbound_json(body);
    let req = apply_upstream_auth(
        ctx.client.post(upstream_url).json(&payload),
        ctx,
    );
    req.send()
        .await
        .map_err(|e| AdapterError::Upstream(e.to_string()))
}

/// Forwards raw bytes upstream with egress enforcement (no DLP on opaque bodies).
pub async fn forward_upstream_bytes(
    ctx: &AdapterContext,
    upstream_url: &str,
    body: bytes::Bytes,
) -> Result<reqwest::Response, AdapterError> {
    ensure_egress_allowed(&ctx.app_state, upstream_url, false)?;
    let req = apply_upstream_auth(ctx.client.post(upstream_url).body(body), ctx);
    req.send()
        .await
        .map_err(|e| AdapterError::Upstream(e.to_string()))
}

/// Builds an upstream error response from status and body bytes.
pub fn upstream_response_to_axum(
    status: StatusCode,
    headers: &reqwest::header::HeaderMap,
    bytes: bytes::Bytes,
) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(ct) = headers.get(header::CONTENT_TYPE) {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Normalizes SSE event delimiters to support CRLF.
pub fn normalize_sse_buffer(buffer: &mut String) {
    if buffer.contains("\r\n") {
        *buffer = buffer.replace("\r\n", "\n");
    }
}

/// Extracts the next SSE data event from a buffer, returning None if incomplete.
pub fn take_sse_data_event(buffer: &mut String) -> Option<String> {
    normalize_sse_buffer(buffer);
    let pos = buffer.find("\n\n")?;
    let block = buffer[..pos].to_string();
    buffer.drain(..pos + 2);
    let mut data_lines = Vec::new();
    for line in block.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim_start().to_string());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    Some(data_lines.join("\n"))
}

/// Appends to an SSE buffer with a size cap.
pub fn append_sse_chunk(buffer: &mut String, chunk: &str) -> Result<(), AdapterError> {
    if buffer.len() + chunk.len() > MAX_SSE_BUFFER_BYTES {
        warn!("SSE buffer exceeded {MAX_SSE_BUFFER_BYTES} bytes");
        return Err(AdapterError::Other("upstream stream buffer limit exceeded".into()));
    }
    buffer.push_str(chunk);
    Ok(())
}

#[cfg(test)]
mod forward_tests {
    use super::*;

    #[test]
    fn loopback_llama_urls_are_recognized() {
        assert!(is_loopback_llama_url("http://127.0.0.1:8081"));
        assert!(is_loopback_llama_url("http://localhost:8081"));
        assert!(!is_loopback_llama_url("http://evil.example.com:8081"));
    }
}

/// Ensures upstream URLs end with `/chat/completions` when given a base OpenAI-compatible URL.
pub fn normalize_upstream_chat_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains(CHAT_COMPLETIONS_SUFFIX) || trimmed.ends_with("/completions") {
        return trimmed.to_string();
    }
    if trimmed.ends_with("/openai")
        || trimmed.ends_with("/v1beta/openai")
        || trimmed.ends_with("/v1beta")
        || ends_with_version_segment(trimmed)
    {
        return format!("{trimmed}{CHAT_COMPLETIONS_SUFFIX}");
    }
    format!("{trimmed}/v1{CHAT_COMPLETIONS_SUFFIX}")
}

fn ends_with_version_segment(url: &str) -> bool {
    url.rsplit('/')
        .next()
        .is_some_and(|segment| segment.starts_with('v') && segment[1..].chars().all(|c| c.is_ascii_digit()))
}

/// True when upstream targets this sidecar process (misconfiguration).
pub fn points_at_sidecar(upstream: &str, sidecar_port: u16) -> bool {
    let Ok(parsed) = reqwest::Url::parse(upstream) else {
        return upstream.contains(&format!("127.0.0.1:{sidecar_port}"))
            || upstream.contains(&format!("localhost:{sidecar_port}"));
    };
    let host = parsed.host_str().unwrap_or("");
    let is_loopback = host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost");
    let port = parsed.port().unwrap_or(if parsed.scheme() == "https" { 443 } else { 80 });
    is_loopback && port == sidecar_port
}

/// Logs a short preview of failed upstream responses.
pub fn log_upstream_error(upstream: &str, status: reqwest::StatusCode, body: &[u8]) {
    let preview = String::from_utf8_lossy(body);
    let preview = preview.chars().take(400).collect::<String>();
    warn!(
        target: "upstream",
        upstream = %redact_url(upstream),
        status = status.as_u16(),
        body = %preview,
        "upstream request failed"
    );
}

pub fn redact_url(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    if let Some((_, value)) = parsed.query_pairs().find(|(k, _)| k == "key") {
        let marker = value.to_string();
        return url.replace(&marker, "***");
    }
    parsed.set_query(None);
    parsed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_chat_completions_to_openai_base() {
        assert_eq!(
            normalize_upstream_chat_url("https://generativelanguage.googleapis.com/v1beta/openai"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
    }

    #[test]
    fn leaves_full_completions_url_unchanged() {
        let url = "https://api.example.com/v1/chat/completions";
        assert_eq!(normalize_upstream_chat_url(url), url);
    }

    #[test]
    fn appends_to_v1_base() {
        assert_eq!(
            normalize_upstream_chat_url("https://api.example.com/v1"),
            "https://api.example.com/v1/chat/completions"
        );
    }
}
