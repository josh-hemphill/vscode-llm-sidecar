use crate::profiles::{merge_profiles, builtin_profiles, NamedProfile};
use crate::upstream::{normalize_upstream_chat_url, points_at_sidecar, redact_url};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default = "default_true")]
    pub tool_calling: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub max_input_tokens: Option<u32>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    /// When set, requests using this catalog model id are forwarded upstream with this id.
    #[serde(default)]
    pub upstream_model_id: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_tools_policy() -> String {
    "strip".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticHint {
    pub file: String,
    pub line: u32,
    pub message: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub open_files: Vec<String>,
    #[serde(default)]
    pub recent_files: Vec<String>,
    #[serde(default)]
    pub diagnostics: Vec<DiagnosticHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorConfig {
    #[serde(default = "default_llama_url")]
    pub llama_base_url: String,
    #[serde(default = "default_orchestrator_model")]
    pub orchestrator_model: String,
    #[serde(default = "default_context_budget")]
    pub context_token_budget: usize,
    #[serde(default)]
    pub local_only: bool,
    #[serde(default)]
    pub egress_allowlist: Vec<String>,
    #[serde(default)]
    pub workspace: WorkspaceContext,
    #[serde(default = "default_slot_id")]
    pub llama_slot_id: i32,
    #[serde(default = "default_max_candidate_tools")]
    pub max_candidate_tools: usize,
    #[serde(default = "default_max_tool_calls_per_turn")]
    pub max_tool_calls_per_turn: usize,
}

fn default_llama_url() -> String {
    "http://127.0.0.1:8081".into()
}

fn default_orchestrator_model() -> String {
    "orchestrator".into()
}

fn default_context_budget() -> usize {
    12_000
}

fn default_slot_id() -> i32 {
    0
}

fn default_max_candidate_tools() -> usize {
    12
}

fn default_max_tool_calls_per_turn() -> usize {
    3
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            llama_base_url: default_llama_url(),
            orchestrator_model: default_orchestrator_model(),
            context_token_budget: default_context_budget(),
            local_only: false,
            egress_allowlist: Vec::new(),
            workspace: WorkspaceContext::default(),
            llama_slot_id: default_slot_id(),
            max_candidate_tools: default_max_candidate_tools(),
            max_tool_calls_per_turn: default_max_tool_calls_per_turn(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointConfig {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub upstream_url: String,
    pub adapter: String,
    #[serde(default = "default_tools_policy")]
    pub tools_policy: String,
    #[serde(default)]
    pub adapter_profile: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfigPayload {
    #[serde(default)]
    pub profiles: HashMap<String, NamedProfile>,
    #[serde(default)]
    pub endpoints: Vec<EndpointConfig>,
    #[serde(default)]
    pub orchestrator: OrchestratorConfig,
}

#[derive(Debug, Clone)]
pub struct ResolvedEndpoint {
    pub endpoint: EndpointConfig,
    pub profile: NamedProfile,
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub profiles: HashMap<String, NamedProfile>,
    pub endpoints: Vec<EndpointConfig>,
    pub model_index: HashMap<String, ResolvedEndpoint>,
    pub orchestrator: OrchestratorConfig,
}

impl AppState {
    pub fn from_payload(mut payload: ProxyConfigPayload) -> Self {
        let sidecar_port: u16 = std::env::var("LLM_SIDECAR_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3848);
        for ep in &mut payload.endpoints {
            let raw = ep.upstream_url.clone();
            let normalized = normalize_upstream_chat_url(&raw);
            if normalized != raw {
                tracing::info!(
                    "normalized upstream for endpoint {}: {} -> {}",
                    ep.id,
                    redact_url(&raw),
                    redact_url(&normalized)
                );
                ep.upstream_url = normalized;
            }
            if points_at_sidecar(&ep.upstream_url, sidecar_port) {
                tracing::warn!(
                    "endpoint {} upstream_url points at this sidecar ({}); configure your provider URL instead",
                    ep.id,
                    ep.upstream_url
                );
            }
        }
        let profiles = merge_profiles(builtin_profiles(), payload.profiles);
        let mut model_index = HashMap::new();
        for ep in &payload.endpoints {
            let profile_name = ep
                .adapter_profile
                .clone()
                .unwrap_or_else(|| "orchestrated-tools".into());
            let profile = profiles
                .get(&profile_name)
                .cloned()
                .unwrap_or_default();
            let resolved = ResolvedEndpoint {
                endpoint: ep.clone(),
                profile,
            };
            for m in &ep.models {
                model_index.insert(m.id.clone(), resolved.clone());
            }
        }
        Self {
            profiles,
            endpoints: payload.endpoints,
            model_index,
            orchestrator: payload.orchestrator,
        }
    }

    pub fn resolve_model(&self, model_id: &str) -> Option<&ResolvedEndpoint> {
        self.model_index.get(model_id)
    }

    pub fn is_egress_allowed(&self, url: &str) -> bool {
        if self.orchestrator.local_only {
            return false;
        }
        if self.orchestrator.egress_allowlist.is_empty() {
            return true;
        }
        self.orchestrator
            .egress_allowlist
            .iter()
            .any(|allowed| url_matches_allowlist(url, allowed))
    }
}

fn url_matches_allowlist(url: &str, allowed: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Ok(allowed_parsed) = reqwest::Url::parse(allowed) else {
        return url.starts_with(allowed);
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let allowed_host = allowed_parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host != allowed_host {
        return false;
    }
    if parsed.scheme() != allowed_parsed.scheme() {
        return false;
    }
    if allowed_parsed.username() != "" || allowed_parsed.password().is_some() {
        return false;
    }
    let path = parsed.path();
    let allowed_path = allowed_parsed.path().trim_end_matches('/');
    if allowed_path.is_empty() || allowed_path == "/" {
        return true;
    }
    path.starts_with(allowed_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn egress_allowlist_blocks_unknown_hosts() {
        let mut state = AppState::from_payload(ProxyConfigPayload::default());
        state.orchestrator.egress_allowlist = vec!["https://corp.example.com".into()];
        assert!(state.is_egress_allowed("https://corp.example.com/v1/chat"));
        assert!(!state.is_egress_allowed("https://evil.example.com/v1/chat"));
        assert!(!state.is_egress_allowed("https://corp.example.com.evil.net/v1/chat"));
    }

    #[test]
    fn local_only_blocks_all_egress() {
        let mut state = AppState::from_payload(ProxyConfigPayload::default());
        state.orchestrator.local_only = true;
        assert!(!state.is_egress_allowed("https://corp.example.com/v1/chat"));
    }
}
