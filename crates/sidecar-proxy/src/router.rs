use crate::adapters::{AdapterContext, AdapterError, AdapterKind};
use crate::config::{AppState, ResolvedEndpoint};
use crate::upstream::redact_url;
use serde_json::Value;
use tracing::info;

pub async fn route_chat(
    state: &AppState,
    client: &reqwest::Client,
    client_authorization: Option<String>,
    body: Value,
) -> Result<axum::response::Response, AdapterError> {
    let model = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    if model.is_empty() {
        return Err(AdapterError::Other("missing model in request body".into()));
    }

    let resolved = state
        .resolve_model(&model)
        .cloned()
        .or_else(|| fallback_endpoint(state, &model))
        .ok_or_else(|| AdapterError::Other(format!("unknown model: {model}")))?;

    let has_tools = body
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    let kind = select_adapter_kind(&resolved.endpoint.adapter, has_tools)?;
    info!(
        "route model={model} endpoint={} adapter={} upstream={}",
        resolved.endpoint.id,
        resolved.endpoint.adapter,
        redact_url(&resolved.endpoint.upstream_url)
    );
    let ctx = AdapterContext {
        client: client.clone(),
        resolved,
        orchestrator: state.orchestrator.clone(),
        app_state: state.clone(),
        client_authorization,
    };

    match kind {
        AdapterKind::PassThrough => {
            crate::adapters::PassThroughAdapter::chat_completions_value(&ctx, body).await
        }
        _ => {
            let request: crate::openai::ChatCompletionRequest =
                serde_json::from_value(body).map_err(|e| {
                    AdapterError::Other(format!("invalid chat completion request: {e}"))
                })?;
            kind.chat_completions(&ctx, request).await
        }
    }
}

/// Routes tool-bearing requests through local bind-and-return regardless of endpoint adapter.
fn select_adapter_kind(
    endpoint_adapter: &str,
    has_tools: bool,
) -> Result<AdapterKind, AdapterError> {
    if has_tools {
        return Ok(AdapterKind::OrchestratedTools);
    }
    AdapterKind::from_id(endpoint_adapter)
}

fn fallback_endpoint(state: &AppState, model_id: &str) -> Option<ResolvedEndpoint> {
    let ep = state.endpoints.first()?;
    let profile_name = ep
        .adapter_profile
        .clone()
        .unwrap_or_else(|| "orchestrated-tools".into());
    let profile = state
        .profiles
        .get(&profile_name)
        .cloned()
        .unwrap_or_default();
    let mut endpoint = ep.clone();
    if endpoint.models.iter().all(|m| m.id != model_id) {
        endpoint.models.push(crate::config::ModelConfig {
            id: model_id.to_string(),
            name: Some(model_id.to_string()),
            tool_calling: true,
            vision: false,
            max_input_tokens: None,
            max_output_tokens: None,
            upstream_model_id: None,
        });
    }
    Some(ResolvedEndpoint { endpoint, profile })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_tools_through_orchestrated_regardless_of_endpoint_adapter() {
        let kind = select_adapter_kind("openai-pass-through", true).unwrap();
        assert!(matches!(kind, AdapterKind::OrchestratedTools));
    }

    #[test]
    fn keeps_pass_through_without_tools() {
        let kind = select_adapter_kind("openai-pass-through", false).unwrap();
        assert!(matches!(kind, AdapterKind::PassThrough));
    }

    #[test]
    fn routes_inline_xml_tools_when_tools_present() {
        let kind = select_adapter_kind("inline-xml-tools", true).unwrap();
        assert!(matches!(kind, AdapterKind::OrchestratedTools));
    }
}
