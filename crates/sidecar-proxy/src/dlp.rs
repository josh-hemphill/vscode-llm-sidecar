use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

static SECRET_PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();

fn secret_patterns() -> &'static [Regex] {
    SECRET_PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r#"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-./]{8,}"#)
                .unwrap(),
            Regex::new(r#"(?i)Bearer\s+[A-Za-z0-9_\-.]+"#).unwrap(),
            Regex::new(r#"(?i)-----BEGIN\s+[A-Z ]+PRIVATE KEY-----"#).unwrap(),
            Regex::new(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap(),
        ]
    })
}

/// Redacts likely secrets and PII from outbound text.
pub fn redact_text(input: &str) -> String {
    let mut out = input.to_string();
    for re in secret_patterns() {
        out = re.replace_all(&out, "[REDACTED]").into_owned();
    }
    out
}

/// Redacts all string fields in a JSON value recursively.
pub fn redact_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(redact_text(s)),
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(redact_value).collect())
        }
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), redact_value(v));
            }
            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub timestamp: String,
    pub endpoint_id: String,
    pub model: String,
    pub upstream_url: String,
    pub redacted_payload_hash: String,
    pub emitted_tool_calls: Vec<String>,
    pub local_only: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_api_key_patterns() {
        let input = "Use api_key=sk-secret12345 for auth";
        let out = redact_text(input);
        assert!(!out.contains("sk-secret12345"));
        assert!(out.contains("[REDACTED]"));
    }
}
