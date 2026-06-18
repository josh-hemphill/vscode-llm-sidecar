use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::openai::openai_error_response;
use crate::router;
use crate::upstream::MAX_BODY_BYTES;

/// Converts an OpenAI Responses API request body into chat-completions shape.
pub fn responses_to_chat_request(body: &Value) -> Value {
    let mut chat = json!({
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "stream": body.get("stream").cloned().unwrap_or(json!(false)),
    });
    if let Some(tools) = body.get("tools") {
        chat["tools"] = tools.clone();
    }
    if let Some(tool_choice) = body.get("tool_choice") {
        chat["tool_choice"] = tool_choice.clone();
    }
    if let Some(opts) = body.get("stream_options") {
        chat["stream_options"] = opts.clone();
    }
    if let Some(temp) = body.get("temperature") {
        chat["temperature"] = temp.clone();
    }
    if let Some(max) = body.get("max_output_tokens").or_else(|| body.get("max_tokens")) {
        chat["max_tokens"] = max.clone();
    }

    let mut messages = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(|v| v.as_str()) {
        if !instructions.is_empty() {
            messages.push(json!({ "role": "system", "content": instructions }));
        }
    }
    if let Some(input) = body.get("input") {
        messages.extend(input_to_messages(input));
    }
    chat["messages"] = Value::Array(messages);
    chat
}

fn input_to_messages(input: &Value) -> Vec<Value> {
    match input {
        Value::String(text) => vec![json!({ "role": "user", "content": text })],
        Value::Array(items) => items
            .iter()
            .filter_map(input_item_to_message)
            .collect(),
        _ => vec![json!({ "role": "user", "content": input.to_string() })],
    }
}

fn input_item_to_message(item: &Value) -> Option<Value> {
    if let Some(text) = item.as_str() {
        return Some(json!({ "role": "user", "content": text }));
    }
    let role = item
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("user");
    if let Some(content) = item.get("content") {
        return Some(json!({ "role": role, "content": content.clone() }));
    }
    if let Some(text) = item
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|parts| parts.first())
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
    {
        return Some(json!({ "role": role, "content": text }));
    }
    None
}

/// Wraps chat-completions routing for POST /v1/responses (Copilot optional Responses API).
pub async fn route_responses(
    state: &crate::config::AppState,
    client: &reqwest::Client,
    client_authorization: Option<String>,
    body: Value,
) -> Response {
    let chat_body = responses_to_chat_request(&body);
    let model = chat_body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("(missing)")
        .to_string();
    let stream = chat_body
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);
    tracing::info!("responses shim model={model} stream={stream}");
    match router::route_chat(state, client, client_authorization, chat_body).await {
        Ok(resp) => {
            if stream {
                return resp;
            }
            match response_body_json(resp).await {
                Ok(chat_json) => responses_from_chat_json(&chat_json, &model),
                Err(err) => openai_error_response(StatusCode::BAD_GATEWAY, err),
            }
        }
        Err(err) => openai_error_response(StatusCode::BAD_GATEWAY, err.to_string()),
    }
}

async fn response_body_json(resp: Response) -> Result<Value, String> {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("upstream returned non-JSON ({status}): {e}"))?;
    Ok(parsed)
}

fn responses_from_chat_json(chat: &Value, model: &str) -> Response {
    let message = chat
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"));
    let text = message
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");
    let tool_calls = message
        .and_then(|m| m.get("tool_calls"))
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let response_id = format!("resp_{}", Uuid::new_v4());
    let mut output: Vec<Value> = Vec::new();
    if !text.is_empty() {
        output.push(json!({
            "id": format!("msg_{}", Uuid::new_v4()),
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text }]
        }));
    }
    for call in tool_calls {
        let name = call
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("tool");
        let args = call
            .get("function")
            .and_then(|f| f.get("arguments"))
            .map(|a| a.to_string())
            .unwrap_or_else(|| "{}".into());
        output.push(json!({
            "id": call.get("id").and_then(|v| v.as_str()).unwrap_or("call"),
            "type": "function_call",
            "name": name,
            "arguments": args,
            "status": "completed"
        }));
    }
    if output.is_empty() {
        output.push(json!({
            "id": format!("msg_{}", Uuid::new_v4()),
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "" }]
        }));
    }
    let body = json!({
        "id": response_id,
        "object": "response",
        "created_at": chrono_now_secs(),
        "model": chat.get("model").and_then(|m| m.as_str()).unwrap_or(model),
        "output": output,
        "output_text": text,
        "status": "completed"
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn chrono_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_string_input_to_user_message() {
        let body = json!({ "model": "m", "input": "hello" });
        let chat = responses_to_chat_request(&body);
        assert_eq!(chat["messages"][0]["role"], "user");
        assert_eq!(chat["messages"][0]["content"], "hello");
    }

    #[test]
    fn prepends_instructions_as_system() {
        let body = json!({
            "model": "m",
            "instructions": "be helpful",
            "input": "hi"
        });
        let chat = responses_to_chat_request(&body);
        assert_eq!(chat["messages"][0]["role"], "system");
        assert_eq!(chat["messages"][1]["role"], "user");
    }
}
