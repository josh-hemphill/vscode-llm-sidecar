use crate::grammar::GrammarPayload;
use crate::upstream::is_loopback_llama_url;
use reqwest::Client;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct LlamaClient {
    pub base_url: String,
    pub model: String,
    pub slot_id: Option<i32>,
    client: Client,
    local_only: bool,
}

impl LlamaClient {
    pub fn new(base_url: String, model: String, client: Client, local_only: bool) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            model,
            slot_id: None,
            client,
            local_only,
        }
    }

    fn ensure_llama_egress(&self) -> Result<(), String> {
        if self.local_only && !is_loopback_llama_url(&self.base_url) {
            return Err("local-only mode requires llama-server on loopback".into());
        }
        Ok(())
    }

    /// Probes llama-server health endpoint.
    pub async fn health(&self) -> bool {
        let url = format!("{}/health", self.base_url);
        self.client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Resolves placeholder ids (e.g. orchestrator) to the loaded llama-server model.
    pub async fn resolve_model_id(&self) -> String {
        if self.model != "orchestrator" {
            return self.model.clone();
        }
        let url = format!("{}/v1/models", self.base_url);
        let Ok(resp) = self.client.get(&url).send().await else {
            return self.model.clone();
        };
        if !resp.status().is_success() {
            return self.model.clone();
        }
        let Ok(parsed) = resp.json::<Value>().await else {
            return self.model.clone();
        };
        parsed
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("id"))
            .and_then(|id| id.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| self.model.clone())
    }

    /// Runs a grammar-constrained completion against llama-server.
    pub async fn bind_completion(
        &self,
        system: &str,
        user: &str,
        grammar: &GrammarPayload,
        cache_prompt: bool,
    ) -> Result<String, String> {
        self.ensure_llama_egress()?;
        let model = self.resolve_model_id().await;
        let mut body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ],
            "temperature": 0.0,
            "stream": false,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "tool_bind",
                    "strict": true,
                    "schema": grammar.json_schema
                }
            }
        });
        if cache_prompt {
            body["cache_prompt"] = json!(true);
        }
        if let Some(slot) = self.slot_id {
            body["id_slot"] = json!(slot);
        }

        let url = format!("{}/v1/chat/completions", self.base_url);
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("llama-server error: {}", resp.status()));
        }
        let parsed: Value = resp.json().await.map_err(|e| e.to_string())?;
        let content = parsed
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        Ok(content)
    }
}
