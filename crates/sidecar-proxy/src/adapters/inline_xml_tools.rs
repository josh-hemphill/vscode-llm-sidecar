use super::{AdapterContext, AdapterError};
use crate::openai::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage, Choice, MessageContent,
    StreamChunk, StreamChoice, StreamDelta, StreamToolCallDelta, StreamToolFunctionDelta,
    ToolCall, ToolCallFunction,
};
use crate::profiles::{NamedProfile, ToolFormatProfile};
use crate::upstream::{append_sse_chunk, forward_upstream_json, take_sse_data_event};
use axum::body::Body;
use axum::response::Response;
use axum::http::{header, StatusCode};
use futures_util::StreamExt;
use regex::Regex;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct InlineXmlToolsAdapter;

impl InlineXmlToolsAdapter {
    pub async fn chat_completions(
        ctx: &AdapterContext,
        request: ChatCompletionRequest,
    ) -> Result<Response, AdapterError> {
        let stream = request.stream.unwrap_or(false);
        let upstream_body = transform_request(&request, &ctx.resolved.profile)?;
        let upstream = ctx.resolved.endpoint.upstream_url.clone();
        let resp = forward_upstream_json(ctx, &upstream, &upstream_body).await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Ok(Response::builder()
                .status(status)
                .body(Body::from(text))
                .unwrap());
        }
        let content_type = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if stream || content_type.contains("text/event-stream") {
            return transform_sse_response(
                resp,
                &request.model,
                &ctx.resolved.profile.tool_format_profile,
            )
            .await;
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AdapterError::Upstream(e.to_string()))?;
        let text = String::from_utf8_lossy(&bytes);
        let normalized = transform_non_stream_body(&text, &request.model, &ctx.resolved.profile.tool_format_profile)?;
        Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(normalized))
            .unwrap())
    }
}

fn transform_request(
    request: &ChatCompletionRequest,
    named_profile: &NamedProfile,
) -> Result<Value, AdapterError> {
    let profile = &named_profile.tool_format_profile;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(tools) = &request.tools {
        if !tools.is_empty() {
            let preamble = build_tools_preamble(tools, profile);
            messages.push(serde_json::json!({
                "role": "system",
                "content": preamble
            }));
        }
    }
    for extra in &named_profile.additional_system_prompts {
        let trimmed = extra.trim();
        if !trimmed.is_empty() {
            messages.push(serde_json::json!({
                "role": "system",
                "content": trimmed
            }));
        }
    }
    for msg in &request.messages {
        messages.push(encode_message(msg, profile)?);
    }
    let mut body = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": request.stream.unwrap_or(false),
    });
    if let Some(tc) = &request.tool_choice {
        body["tool_choice"] = tc.clone();
    }
    if profile.allow_native_tools {
        if let Some(tools) = &request.tools {
            body["tools"] = Value::Array(tools.clone());
        }
    }
    Ok(body)
}

fn build_tools_preamble(tools: &[Value], profile: &ToolFormatProfile) -> String {
    let mut lines = vec![
        "You may call tools using the following XML format.".into(),
        format!(
            "Call: {} {}=\"TOOL_NAME\" {}=\"CALL_ID\">ARGUMENTS_JSON{}",
            profile.tool_call_open,
            profile.name_attribute,
            profile.id_attribute,
            profile.tool_call_close
        ),
        format!(
            "Result: {} {}=\"TOOL_NAME\" {}=\"CALL_ID\">result body{}",
            profile.tool_result_open,
            profile.name_attribute,
            profile.id_attribute,
            profile.tool_result_close
        ),
    ];
    lines.push("Available tools JSON schema:".into());
    lines.push(serde_json::to_string(tools).unwrap_or_else(|_| "[]".into()));
    lines.join("\n")
}

fn encode_message(msg: &ChatMessage, profile: &ToolFormatProfile) -> Result<Value, AdapterError> {
    if msg.role == "tool" {
        let name = msg.name.clone().unwrap_or_else(|| "tool".into());
        let id = msg.tool_call_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
        let content = message_content_to_string(msg);
        let body = format!(
            "{} {}=\"{}\" {}=\"{}\">\n{}\n{}",
            profile.tool_result_open,
            profile.name_attribute,
            name,
            profile.id_attribute,
            id,
            content,
            profile.tool_result_close
        );
        return Ok(serde_json::json!({ "role": "user", "content": body }));
    }
    if msg.role == "assistant" {
        if let Some(calls) = &msg.tool_calls {
            let mut parts = vec![message_content_to_string(msg)];
            for call in calls {
                parts.push(encode_tool_call(call, profile));
            }
            return Ok(serde_json::json!({
                "role": "assistant",
                "content": parts.join("\n")
            }));
        }
    }
    Ok(serde_json::json!({
        "role": msg.role,
        "content": message_content_to_string(msg)
    }))
}

fn encode_tool_call(call: &ToolCall, profile: &ToolFormatProfile) -> String {
    format!(
        "{} {}=\"{}\" {}=\"{}\">\n{}\n{}",
        profile.tool_call_open,
        profile.name_attribute,
        call.function.name,
        profile.id_attribute,
        call.id,
        call.function.arguments,
        profile.tool_call_close
    )
}

fn message_content_to_string(msg: &ChatMessage) -> String {
    match &msg.content {
        Some(MessageContent::Text(t)) => t.clone(),
        Some(MessageContent::Parts(parts)) => serde_json::to_string(parts).unwrap_or_default(),
        None => String::new(),
    }
}

fn transform_non_stream_body(
    raw: &str,
    model: &str,
    profile: &ToolFormatProfile,
) -> Result<String, AdapterError> {
    if let Ok(mut parsed) = serde_json::from_str::<Value>(raw) {
        if let Some(choices) = parsed.get_mut("choices").and_then(|c| c.as_array_mut()) {
            for choice in choices {
                if let Some(msg) = choice.get_mut("message") {
                    normalize_message_value(msg, profile);
                }
            }
        }
        return Ok(serde_json::to_string(&parsed)?);
    }
    let (content, extracted_calls) = extract_from_text(raw, profile);
    let has_tools = !extracted_calls.is_empty();
    let response = ChatCompletionResponse {
        id: format!("chatcmpl-{}", Uuid::new_v4()),
        object: "chat.completion".into(),
        created: now_secs(),
        model: model.into(),
        choices: vec![Choice {
            index: 0,
            message: ChatMessage {
                role: "assistant".into(),
                content: Some(MessageContent::Text(content)),
                tool_calls: if has_tools {
                    Some(extracted_calls)
                } else {
                    None
                },
                tool_call_id: None,
                name: None,
            },
            finish_reason: Some(if has_tools {
                "tool_calls".into()
            } else {
                "stop".into()
            }),
        }],
        usage: None,
    };
    Ok(serde_json::to_string(&response)?)
}

fn normalize_message_value(msg: &mut Value, profile: &ToolFormatProfile) {
    let content = msg
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let (text, tool_calls) = extract_from_text(&content, profile);
    if !tool_calls.is_empty() {
        msg["content"] = Value::String(text);
        msg["tool_calls"] = serde_json::to_value(&tool_calls).unwrap_or(Value::Null);
    }
}

async fn transform_sse_response(
    resp: reqwest::Response,
    model: &str,
    profile: &ToolFormatProfile,
) -> Result<Response, AdapterError> {
    let model = model.to_string();
    let profile = profile.clone();
    let stream = resp.bytes_stream();
    let body = Body::from_stream(async_stream::stream! {
        let mut buffer = String::new();
        let mut upstream = stream;
        while let Some(chunk) = upstream.next().await {
            let Ok(bytes) = chunk else { continue };
            let chunk_str = String::from_utf8_lossy(&bytes);
            if append_sse_chunk(&mut buffer, &chunk_str).is_err() {
                break;
            }
            while let Some(event) = take_sse_data_event(&mut buffer) {
                if event == "[DONE]" {
                    yield Ok::<_, std::convert::Infallible>("data: [DONE]\n\n".to_string());
                    continue;
                }
                if let Ok(mut parsed) = serde_json::from_str::<Value>(&event) {
                    if let Some(choices) = parsed.get_mut("choices").and_then(|c| c.as_array_mut()) {
                        for choice in choices {
                            if let Some(delta) = choice.get_mut("delta") {
                                if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                    let (text, tool_calls) = extract_from_text(content, &profile);
                                    delta["content"] = Value::String(text);
                                    if !tool_calls.is_empty() {
                                        let deltas: Vec<StreamToolCallDelta> = tool_calls
                                            .iter()
                                            .enumerate()
                                            .map(|(i, tc)| StreamToolCallDelta {
                                                index: i as u32,
                                                id: Some(tc.id.clone()),
                                                call_type: Some("function".into()),
                                                function: Some(StreamToolFunctionDelta {
                                                    name: Some(tc.function.name.clone()),
                                                    arguments: Some(tc.function.arguments.clone()),
                                                }),
                                            })
                                            .collect();
                                        delta["tool_calls"] = serde_json::to_value(deltas).unwrap_or(Value::Null);
                                    }
                                }
                            }
                        }
                    }
                    yield Ok(format!("data: {}\n\n", parsed));
                } else {
                    yield Ok(format!("data: {}\n\n", event));
                }
            }
        }
        if !buffer.trim().is_empty() {
            let (text, tool_calls) = extract_from_text(&buffer, &profile);
            if !tool_calls.is_empty() || !text.is_empty() {
                let chunk = StreamChunk {
                    id: format!("chatcmpl-{}", Uuid::new_v4()),
                    object: "chat.completion.chunk".into(),
                    created: now_secs(),
                    model: model.clone(),
                    choices: vec![StreamChoice {
                        index: 0,
                        delta: StreamDelta {
                            role: Some("assistant".into()),
                            content: if text.is_empty() { None } else { Some(text) },
                            tool_calls: if tool_calls.is_empty() {
                                None
                            } else {
                                Some(
                                    tool_calls
                                        .iter()
                                        .enumerate()
                                        .map(|(i, tc)| StreamToolCallDelta {
                                            index: i as u32,
                                            id: Some(tc.id.clone()),
                                            call_type: Some("function".into()),
                                            function: Some(StreamToolFunctionDelta {
                                                name: Some(tc.function.name.clone()),
                                                arguments: Some(tc.function.arguments.clone()),
                                            }),
                                        })
                                        .collect(),
                                )
                            },
                        },
                        finish_reason: Some("tool_calls".into()),
                    }],
                };
                if let Ok(json) = serde_json::to_string(&chunk) {
                    yield Ok(format!("data: {}\n\n", json));
                }
            }
        }
        yield Ok("data: [DONE]\n\n".into());
    });
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap())
}

fn extract_from_text(text: &str, profile: &ToolFormatProfile) -> (String, Vec<ToolCall>) {
    let open = regex_escape(&profile.tool_call_open);
    let close = regex_escape(&profile.tool_call_close);
    let name_attr = regex_escape(&profile.name_attribute);
    let id_attr = regex_escape(&profile.id_attribute);
    let pattern = format!(
        "(?s){open}\\s+{name_attr}=\"([^\"]+)\"\\s+{id_attr}=\"([^\"]+)\"\\s*>(.*?){close}",
        open = open,
        name_attr = name_attr,
        id_attr = id_attr,
        close = close
    );
    let re = Regex::new(&pattern).ok();
    let mut tool_calls = Vec::new();
    let mut cleaned = text.to_string();
    if let Some(re) = re {
        for caps in re.captures_iter(text) {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("tool").to_string();
            let id = caps
                .get(2)
                .map(|m| m.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let args = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("{}").to_string();
            tool_calls.push(ToolCall {
                id: id.clone(),
                call_type: Some("function".into()),
                function: ToolCallFunction {
                    name,
                    arguments: args,
                },
            });
            if let Some(m) = caps.get(0) {
                cleaned = cleaned.replace(m.as_str(), "");
            }
        }
    }
    (cleaned.trim().to_string(), tool_calls)
}

fn regex_escape(s: &str) -> String {
    regex::escape(s)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openai::{ChatCompletionRequest, ChatMessage, ToolCall, ToolCallFunction};
    use crate::profiles::{NamedProfile, ToolFormatProfile};

    fn default_profile() -> ToolFormatProfile {
        ToolFormatProfile::default()
    }

    #[test]
    fn extracts_single_tool_call() {
        let profile = default_profile();
        let input = r#"Hello <tool_use> name="get_weather" id="call_1">
{"location":"Tokyo"}
</tool_use> done"#;
        let (text, calls) = extract_from_text(input, &profile);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].function.name, "get_weather");
        assert_eq!(calls[0].id, "call_1");
        assert!(!text.contains("tool_use"));
    }

    #[test]
    fn extracts_multiple_tool_calls() {
        let profile = default_profile();
        let input = r#"<tool_use> name="a" id="1">{}</tool_use> mid <tool_use> name="b" id="2">{}</tool_use>"#;
        let (_, calls) = extract_from_text(input, &profile);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].function.name, "a");
        assert_eq!(calls[1].function.name, "b");
    }

    #[test]
    fn encode_tool_call_uses_custom_profile_tags() {
        let profile = ToolFormatProfile {
            tool_call_open: "<invoke>".into(),
            tool_call_close: "</invoke>".into(),
            name_attribute: "tool".into(),
            id_attribute: "call_id".into(),
            ..ToolFormatProfile::default()
        };
        let call = ToolCall {
            id: "c1".into(),
            call_type: Some("function".into()),
            function: ToolCallFunction {
                name: "search".into(),
                arguments: r#"{"q":"x"}"#.into(),
            },
        };
        let encoded = encode_tool_call(&call, &profile);
        assert!(encoded.contains("<invoke>"));
        assert!(encoded.contains("tool=\"search\""));
        assert!(encoded.contains("call_id=\"c1\""));
    }

    #[test]
    fn transform_request_inserts_additional_system_prompts_after_preamble() {
        let named = NamedProfile {
            additional_system_prompts: vec!["Prefer tools for actions.".into()],
            ..Default::default()
        };
        let req = ChatCompletionRequest {
            model: "test".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: Some(MessageContent::Text("hello".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            tools: Some(vec![serde_json::json!({
                "type": "function",
                "function": { "name": "demo", "parameters": {} }
            })]),
            tool_choice: None,
            stream: None,
            extra: std::collections::HashMap::new(),
        };
        let body = transform_request(&req, &named).expect("transform");
        let msgs = body["messages"].as_array().expect("messages");
        assert_eq!(msgs.len(), 3);
        assert!(
            msgs[0]["content"]
                .as_str()
                .unwrap()
                .contains("XML format")
        );
        assert_eq!(msgs[1]["content"], "Prefer tools for actions.");
        assert_eq!(msgs[2]["role"], "user");
    }

    #[test]
    fn transform_request_inserts_extras_without_tools_preamble() {
        let named = NamedProfile {
            additional_system_prompts: vec!["Endpoint tuning.".into()],
            ..Default::default()
        };
        let req = ChatCompletionRequest {
            model: "test".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: Some(MessageContent::Text("hi".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            tools: None,
            tool_choice: None,
            stream: None,
            extra: std::collections::HashMap::new(),
        };
        let body = transform_request(&req, &named).expect("transform");
        let msgs = body["messages"].as_array().expect("messages");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["content"], "Endpoint tuning.");
    }

    #[test]
    fn transform_non_stream_parses_xml_in_body() {
        let raw = r#"{"choices":[{"message":{"role":"assistant","content":"Hi <tool_use> name=\"fn\" id=\"id1\">{}</tool_use>"}}]}"#;
        let out = transform_non_stream_body(raw, "test-model", &ToolFormatProfile::default()).expect("transform");
        let parsed: serde_json::Value = serde_json::from_str(&out).expect("json");
        let tool_calls = parsed["choices"][0]["message"]["tool_calls"]
            .as_array()
            .expect("tool_calls");
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0]["function"]["name"], "fn");
    }
}
