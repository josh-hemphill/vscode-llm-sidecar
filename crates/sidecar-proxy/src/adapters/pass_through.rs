use super::{AdapterContext, AdapterError};
use crate::openai::{ChatCompletionRequest, MessageContent};
use crate::upstream::{forward_upstream_json, log_upstream_error, redact_url};
use axum::body::Body;
use axum::http::header;
use axum::response::Response;
use serde_json::{json, Value};
use tracing::info;

pub struct PassThroughAdapter;

impl PassThroughAdapter {
    /// Forwards the raw JSON body to upstream (preserves Copilot fields like temperature).
    pub async fn chat_completions_value(
        ctx: &AdapterContext,
        body: Value,
    ) -> Result<Response, AdapterError> {
        let payload = if ctx.resolved.endpoint.tools_policy == "strip" {
            sanitize_request_value(body)
        } else {
            body
        };
        let upstream = ctx.resolved.endpoint.upstream_url.clone();
        info!(
            target: "upstream",
            endpoint = %ctx.resolved.endpoint.id,
            upstream = %redact_url(&upstream),
            "forwarding chat completion"
        );
        let resp = forward_upstream_json(ctx, &upstream, &payload).await?;
        let status = resp.status();
        let headers = resp.headers().clone();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AdapterError::Upstream(e.to_string()))?;
        if !status.is_success() {
            log_upstream_error(&upstream, status, &bytes);
        }
        let mut builder = Response::builder().status(status);
        if let Some(ct) = headers.get(header::CONTENT_TYPE) {
            builder = builder.header(header::CONTENT_TYPE, ct);
        }
        Ok(builder
            .body(Body::from(bytes))
            .unwrap_or_else(|_| Response::new(Body::empty())))
    }

    pub async fn chat_completions(
        ctx: &AdapterContext,
        request: ChatCompletionRequest,
    ) -> Result<Response, AdapterError> {
        let body = serde_json::to_value(sanitize_request(
            request,
            &ctx.resolved.endpoint.tools_policy,
        ))?;
        Self::chat_completions_value(ctx, body).await
    }
}

fn sanitize_request_value(mut value: Value) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.remove("tools");
        obj.remove("tool_choice");
    }
    if let Some(messages) = value.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for msg in messages.iter_mut() {
            if msg.get("role").and_then(|r| r.as_str()) == Some("tool") {
                let name = msg
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let text = message_content_value(msg.get("content"));
                msg["role"] = json!("user");
                msg["content"] = json!(format!("[Tool result for {name}] {text}"));
                if let Some(obj) = msg.as_object_mut() {
                    obj.remove("name");
                    obj.remove("tool_call_id");
                    obj.remove("tool_calls");
                }
            } else if let Some(obj) = msg.as_object_mut() {
                obj.remove("tool_calls");
            }
        }
    }
    value
}

fn message_content_value(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => serde_json::to_string(parts).unwrap_or_default(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn sanitize_request(mut request: ChatCompletionRequest, tools_policy: &str) -> ChatCompletionRequest {
    if tools_policy != "strip" {
        return request;
    }
    request.tools = None;
    request.tool_choice = None;
    for msg in &mut request.messages {
        if msg.role == "tool" {
            msg.role = "user".into();
            let name = msg.name.clone().unwrap_or_else(|| "tool".into());
            let text = match &msg.content {
                Some(MessageContent::Text(s)) => s.clone(),
                Some(MessageContent::Parts(parts)) => {
                    serde_json::to_string(parts).unwrap_or_default()
                }
                None => String::new(),
            };
            msg.content = Some(MessageContent::Text(format!(
                "[Tool result for {name}] {text}"
            )));
            msg.name = None;
            msg.tool_call_id = None;
        }
        msg.tool_calls = None;
    }
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openai::{ChatMessage, ToolCall, ToolCallFunction};
    use serde_json::json;

    #[test]
    fn strip_policy_drops_tools_and_tool_choice() {
        let req = ChatCompletionRequest {
            model: "m".into(),
            messages: vec![],
            tools: Some(vec![json!({"type":"function"})]),
            tool_choice: Some(json!({"type":"auto"})),
            stream: None,
            extra: std::collections::HashMap::new(),
        };
        let out = sanitize_request(req, "strip");
        assert!(out.tools.is_none());
        assert!(out.tool_choice.is_none());
    }

    #[test]
    fn strip_policy_normalizes_tool_messages() {
        let req = ChatCompletionRequest {
            model: "m".into(),
            messages: vec![
                ChatMessage {
                    role: "assistant".into(),
                    content: Some(MessageContent::Text("before".into())),
                    tool_calls: Some(vec![ToolCall {
                        id: "1".into(),
                        call_type: Some("function".into()),
                        function: ToolCallFunction {
                            name: "lookup".into(),
                            arguments: "{}".into(),
                        },
                    }]),
                    tool_call_id: None,
                    name: None,
                },
                ChatMessage {
                    role: "tool".into(),
                    content: Some(MessageContent::Text("result".into())),
                    tool_calls: None,
                    tool_call_id: Some("1".into()),
                    name: Some("lookup".into()),
                },
            ],
            tools: None,
            tool_choice: None,
            stream: None,
            extra: std::collections::HashMap::new(),
        };
        let out = sanitize_request(req, "strip");
        assert!(out.messages[0].tool_calls.is_none());
        assert_eq!(out.messages[1].role, "user");
        let content = match &out.messages[1].content {
            Some(MessageContent::Text(s)) => s,
            _ => panic!("expected text"),
        };
        assert!(content.contains("[Tool result for lookup]"));
    }

    #[test]
    fn deserializes_tool_arguments_object() {
        let raw = json!({
            "model": "m",
            "messages": [],
            "tools": [{
                "type": "function",
                "function": { "name": "read_file", "parameters": {} }
            }]
        });
        let with_calls = json!({
            "model": "m",
            "messages": [{
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "1",
                    "type": "function",
                    "function": { "name": "read_file", "arguments": { "path": "a.ts" } }
                }]
            }]
        });
        let req: ChatCompletionRequest = serde_json::from_value(with_calls).unwrap();
        assert!(req.messages[0].tool_calls.as_ref().unwrap()[0]
            .function
            .arguments
            .contains("a.ts"));
        let _ = raw;
    }
}
