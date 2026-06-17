mod inline_xml_tools;
mod orchestrated_tools;
mod pass_through;

pub use inline_xml_tools::InlineXmlToolsAdapter;
pub use orchestrated_tools::OrchestratedToolsAdapter;
pub use pass_through::PassThroughAdapter;

use crate::config::{AppState, OrchestratorConfig, ResolvedEndpoint};
use crate::openai::ChatCompletionRequest;
use axum::response::Response;
use reqwest::Client;

#[derive(Clone)]
pub struct AdapterContext {
    pub client: Client,
    pub resolved: ResolvedEndpoint,
    pub orchestrator: OrchestratorConfig,
    pub app_state: AppState,
    /// Authorization header from the editor (Copilot BYOK), used when no upstream key is configured.
    pub client_authorization: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("upstream HTTP error: {0}")]
    Upstream(String),
    #[error("serialization: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

#[derive(Clone, Copy)]
pub enum AdapterKind {
    PassThrough,
    InlineXmlTools,
    OrchestratedTools,
}

impl AdapterKind {
    pub fn from_id(id: &str) -> Result<Self, AdapterError> {
        match id {
            "openai-pass-through" => Ok(Self::PassThrough),
            "inline-xml-tools" | "json-tools-in-text" => Ok(Self::InlineXmlTools),
            "orchestrated-tools" => Ok(Self::OrchestratedTools),
            other => Err(AdapterError::Other(format!("unknown adapter: {other}"))),
        }
    }

    pub async fn chat_completions(
        self,
        ctx: &AdapterContext,
        request: ChatCompletionRequest,
    ) -> Result<Response, AdapterError> {
        match self {
            Self::PassThrough => PassThroughAdapter::chat_completions(ctx, request).await,
            Self::InlineXmlTools => InlineXmlToolsAdapter::chat_completions(ctx, request).await,
            Self::OrchestratedTools => {
                OrchestratedToolsAdapter::chat_completions(ctx, request).await
            }
        }
    }
}

/// Applies configured upstream API key, or falls back to the client Authorization header.
pub fn apply_upstream_auth(
    builder: reqwest::RequestBuilder,
    ctx: &AdapterContext,
) -> reqwest::RequestBuilder {
    if let Some(key) = ctx
        .resolved
        .endpoint
        .api_key
        .as_ref()
        .filter(|k| !k.is_empty())
    {
        return builder.bearer_auth(key);
    }
    if let Some(header) = ctx
        .client_authorization
        .as_ref()
        .filter(|h| !h.is_empty())
    {
        if let Some(token) = header.strip_prefix("Bearer ").or_else(|| header.strip_prefix("bearer "))
        {
            return builder.bearer_auth(token);
        }
        return builder.bearer_auth(header);
    }
    builder
}
