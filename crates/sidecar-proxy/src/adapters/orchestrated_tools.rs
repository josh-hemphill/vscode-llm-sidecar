use super::{AdapterContext, AdapterError};
use crate::context::{gather_context_async, ground_file_path};
use crate::dlp::{redact_text, redact_value, AuditEntry};
use crate::tool_filter::select_candidate_tools;
use crate::upstream::{forward_upstream_json, log_upstream_error, redact_url};
use crate::grammar::{
    build_action_list_schema, build_tool_arguments_schema, hash_tool_set, json_schema_to_gbnf,
    parse_bind_output, BindOutput,
};
use crate::llama_client::LlamaClient;
use crate::openai::{
    ChatCompletionRequest, ChatCompletionResponse, ChatMessage, Choice, MessageContent,
    StreamChunk, StreamChoice, StreamDelta, StreamToolCallDelta, StreamToolFunctionDelta,
    ToolCall, ToolCallFunction,
};
use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct OrchestratedToolsAdapter;

impl OrchestratedToolsAdapter {
    pub async fn chat_completions(
        ctx: &AdapterContext,
        request: ChatCompletionRequest,
    ) -> Result<Response, AdapterError> {
        let tools = request.tools.clone().unwrap_or_default();
        if tools.is_empty() {
            return super::PassThroughAdapter::chat_completions(ctx, request).await;
        }

        let llama = LlamaClient::new(
            ctx.orchestrator.llama_base_url.clone(),
            ctx.orchestrator.orchestrator_model.clone(),
            ctx.client.clone(),
            ctx.orchestrator.local_only,
        );
        crate::activity::record_llama_use();
        let healthy = wait_for_llama_health(&llama, 25_000).await;
        crate::activity::mark_llama_up(healthy);
        if !healthy {
            return Err(AdapterError::Other(
                "llama-server is not running. In VS Code run “LLM Sidecar: Download Llama Server”, ensure llmSidecar.autoStartLlama is true, then reload the window."
                    .into(),
            ));
        }

        let stream = request.stream.unwrap_or(false);
        let orchestrator = ctx.orchestrator.clone();

        let user_query = last_user_message(&request.messages);
        let local_context = gather_context_async(
            user_query.clone(),
            orchestrator.workspace.clone(),
            orchestrator.context_token_budget,
        )
        .await;

        let reason_messages = build_reason_messages(
            &request,
            &ctx.resolved.profile.additional_system_prompts,
            &local_context,
            &tools,
        );
        let upstream_model = resolve_upstream_model(ctx, &request.model);
        let upstream_body = redact_value(&build_upstream_reason_body(
            &request,
            &upstream_model,
            &reason_messages,
        ));
        let upstream = ctx.resolved.endpoint.upstream_url.clone();
        tracing::info!(
            target: "upstream",
            endpoint = %ctx.resolved.endpoint.id,
            upstream = %redact_url(&upstream),
            model = %upstream_model,
            stream = false,
            "orchestrated reason phase"
        );
        let resp = forward_upstream_json(ctx, &upstream, &upstream_body).await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log_upstream_error(&upstream, status, text.as_bytes());
            return Ok(Response::builder()
                .status(status)
                .body(Body::from(text))
                .unwrap());
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| AdapterError::Upstream(e.to_string()))?;
        let reason_text = extract_assistant_text(&String::from_utf8_lossy(&bytes));
        let outcome = run_bind_pipeline(
            ctx,
            &tools,
            &reason_text,
            &user_query,
            &local_context,
            &request.messages,
        )
        .await?;
        record_audit(ctx, &request.model, &outcome.tool_names);
        if stream {
            Ok(build_stream_response(&request.model, outcome))
        } else {
            Ok(build_non_stream_response(&request.model, outcome))
        }
    }
}

struct BindOutcome {
    content: String,
    tool_calls: Vec<ToolCall>,
    tool_names: Vec<String>,
}

/// Polls llama-server health, signaling wanted until healthy or timeout.
async fn wait_for_llama_health(llama: &LlamaClient, timeout_ms: u64) -> bool {
    if llama.health().await {
        return true;
    }
    crate::activity::record_llama_wanted();
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < timeout_ms as u128 {
        if llama.health().await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    llama.health().await
}

async fn run_bind_pipeline(
    ctx: &AdapterContext,
    tools: &[Value],
    reason_text: &str,
    user_query: &str,
    local_context: &str,
    prior_messages: &[ChatMessage],
) -> Result<BindOutcome, AdapterError> {
    let final_answer = |content: &str| BindOutcome {
        content: content.to_string(),
        tool_calls: vec![],
        tool_names: vec![],
    };

    // Safety stop: if the conversation has already churned through many tool
    // rounds, stop calling tools and let the upstream prose stand as the answer.
    if count_prior_tool_results(prior_messages) >= MAX_PRIOR_TOOL_ROUNDS {
        return Ok(final_answer(reason_text));
    }

    let mut llama = LlamaClient::new(
        ctx.orchestrator.llama_base_url.clone(),
        ctx.orchestrator.orchestrator_model.clone(),
        ctx.client.clone(),
        ctx.orchestrator.local_only,
    );
    llama.slot_id = Some(ctx.orchestrator.llama_slot_id);

    let plan_excerpt = truncate_chars(reason_text, MAX_BIND_PLAN_CHARS);
    let query_excerpt = truncate_chars(user_query, MAX_BIND_QUERY_CHARS);
    let context_excerpt = truncate_chars(local_context, MAX_BIND_CONTEXT_CHARS);
    let max_calls = ctx.orchestrator.max_tool_calls_per_turn.max(1);
    let max_candidates = ctx.orchestrator.max_candidate_tools.max(1);

    let prior_keys = prior_tool_call_keys(prior_messages);
    let has_prior_results = count_prior_tool_results(prior_messages) > 0;
    let wants_exec = wants_command_execution(reason_text, user_query);
    let wants_modify = wants_file_modification(reason_text, user_query);
    let allow_mutating = wants_modify || has_prior_results;

    let mut candidates = select_candidate_tools(reason_text, user_query, tools, max_candidates);
    if !wants_exec {
        candidates.retain(|t| !is_guarded_tool(tool_name_of(t)));
    }
    if !allow_mutating {
        // Read-only request with no prior gather round: never offer file-mutating tools.
        candidates.retain(|t| !is_mutating_tool(tool_name_of(t)));
    }
    if candidates.is_empty() {
        return Ok(final_answer(reason_text));
    }

    let selected_names = select_actions_via_llama(
        &mut llama,
        &candidates,
        &plan_excerpt,
        &query_excerpt,
        &context_excerpt,
        prior_messages,
        max_calls,
        has_prior_results,
    )
    .await?;
    if selected_names.is_empty() {
        return Ok(final_answer(reason_text));
    }

    let mut tool_calls = Vec::new();
    for name in selected_names {
        if let Some(call) = bind_single_tool_call(
            &mut llama,
            ctx,
            tools,
            &name,
            &plan_excerpt,
            &query_excerpt,
            &context_excerpt,
            prior_messages,
        )
        .await?
        {
            // Skip calls already issued earlier in this conversation; repeating
            // them is the signature of a stuck agentic loop.
            let key = tool_call_key(&call.function.name, &call.function.arguments);
            if prior_keys.contains(&key) {
                continue;
            }
            tool_calls.push(call);
        }
        if tool_calls.len() >= max_calls {
            break;
        }
    }

    tool_calls = dedupe_tool_calls(tool_calls);
    tool_calls.truncate(max_calls);
    if tool_calls.is_empty() {
        return Ok(final_answer(reason_text));
    }
    let tool_names: Vec<String> = tool_calls
        .iter()
        .map(|c| c.function.name.clone())
        .collect();
    Ok(BindOutcome {
        content: String::new(),
        tool_calls,
        tool_names,
    })
}

#[allow(clippy::too_many_arguments)]
async fn select_actions_via_llama(
    llama: &mut LlamaClient,
    candidates: &[Value],
    plan_excerpt: &str,
    query_excerpt: &str,
    context_excerpt: &str,
    prior_messages: &[ChatMessage],
    max_calls: usize,
    prefer_final: bool,
) -> Result<Vec<String>, AdapterError> {
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    let max_calls = max_calls.max(1);
    let action_schema = build_action_list_schema(candidates, max_calls);
    let grammar = crate::grammar::GrammarPayload {
        tool_set_hash: format!("{}-actions", hash_tool_set(candidates)),
        json_schema: action_schema.clone(),
        gbnf: json_schema_to_gbnf(&action_schema),
    };
    let context_block = if context_excerpt.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nWorkspace context already gathered:\n{context_excerpt}")
    };
    let tool_results_block =
        format_tool_results_section(prior_messages, MAX_BIND_TOOL_RESULTS_CHARS, None);
    let stage_one_user = format!(
        "User request:\n{query_excerpt}\n\nAssistant plan:\n{plan_excerpt}{context_block}{tool_results_block}\n\nAvailable tools:\n{}",
        compact_tool_summaries(candidates)
    );
    let stage_one = llama
        .bind_completion(
            &bind_stage_one_system(prefer_final),
            &stage_one_user,
            &grammar,
            true,
        )
        .await
        .map_err(AdapterError::Other)?;
    let parsed: Value = serde_json::from_str(&stage_one).unwrap_or(json!({"actions":[]}));
    let mut names = Vec::new();
    if let Some(actions) = parsed.get("actions").and_then(|a| a.as_array()) {
        for action in actions {
            if let Some(name) = action.get("name").and_then(|n| n.as_str()) {
                names.push(name.to_string());
            }
        }
    }
    Ok(names)
}

#[allow(clippy::too_many_arguments)]
async fn bind_single_tool_call(
    llama: &mut LlamaClient,
    ctx: &AdapterContext,
    tools: &[Value],
    selected_name: &str,
    plan_excerpt: &str,
    query_excerpt: &str,
    context_excerpt: &str,
    prior_messages: &[ChatMessage],
) -> Result<Option<ToolCall>, AdapterError> {
    let Some(selected_tool) = tools.iter().find(|t| {
        t.get("function")
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            == Some(selected_name)
    }) else {
        return Ok(None);
    };
    let arg_schema = build_tool_arguments_schema(selected_tool);
    let arg_grammar = crate::grammar::GrammarPayload {
        tool_set_hash: format!("{}-args-{selected_name}", hash_tool_set(tools)),
        json_schema: arg_schema.clone(),
        gbnf: json_schema_to_gbnf(&arg_schema),
    };
    let params_block = describe_tool_parameters(selected_tool);
    let stage_two_user = build_stage_two_user_prompt(
        query_excerpt,
        plan_excerpt,
        context_excerpt,
        selected_name,
        &params_block,
        prior_messages,
    );
    let stage_two = llama
        .bind_completion(
            "Fill tool arguments as JSON with fields name and arguments. Use concrete, real values; never placeholders.",
            &stage_two_user,
            &arg_grammar,
            true,
        )
        .await
        .map_err(AdapterError::Other)?;
    let Some((name, arguments)) = parse_stage_two_output(&stage_two) else {
        return Ok(None);
    };
    let mut arguments = arguments;
    if let Ok(mut args_val) = serde_json::from_str::<Value>(&arguments) {
        if let Some(path) = args_val.get("path").and_then(|p| p.as_str()) {
            let grounded = ground_file_path(path, &ctx.orchestrator.workspace);
            if grounded != path {
                args_val["path"] = json!(grounded);
                arguments = serde_json::to_string(&args_val).unwrap_or(arguments);
            }
        }
    }
    // Reject blind/placeholder calls so we never emit e.g. an empty terminal
    // command or a grep with `pattern_to_search_for`.
    if !tool_call_args_are_concrete(selected_tool, &arguments) {
        return Ok(None);
    }
    // Reject paths that escape the workspace (absolute, drive-qualified, or
    // parent-traversing) so we never edit/read files outside the project.
    let has_roots = !ctx.orchestrator.workspace.roots.is_empty();
    if !args_paths_within_workspace(&arguments, has_roots) {
        return Ok(None);
    }
    Ok(Some(ToolCall {
        id: format!("call_{}", Uuid::new_v4()),
        call_type: Some("function".into()),
        function: ToolCallFunction { name, arguments },
    }))
}

/// Parses stage-two bind output (`{name, arguments}` or full bind shape).
fn parse_stage_two_output(raw: &str) -> Option<(String, String)> {
    let parsed: Value = serde_json::from_str(raw.trim()).ok()?;
    if let Some(kind) = parsed.get("kind").and_then(|k| k.as_str()) {
        if let Ok(BindOutput::ToolCall { name, arguments }) = parse_bind_output(&parsed) {
            return Some((name, arguments));
        }
        if kind != "tool_call" {
            return None;
        }
    }
    let name = parsed.get("name").and_then(|n| n.as_str())?.to_string();
    let arguments = parsed
        .get("arguments")
        .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "{}".into()))
        .unwrap_or_else(|| "{}".into());
    Some((name, arguments))
}

fn dedupe_tool_calls(calls: Vec<ToolCall>) -> Vec<ToolCall> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for call in calls {
        let key = tool_call_key(&call.function.name, &call.function.arguments);
        if seen.insert(key) {
            out.push(call);
        }
    }
    out
}

fn bind_stage_one_system(prefer_final: bool) -> String {
    let base = "Select the next actions as JSON with an actions array. Each action must have kind=tool_call and a name from the available tools when the plan needs to read, search, list, or inspect workspace files and the information is not already fully present. Return an empty actions array when you can answer using the plan and workspace context already provided.";
    if prefer_final {
        format!("{base} Tool results have already been gathered in this conversation; strongly prefer an empty actions array unless genuinely new information is still required. Never repeat a tool call that was already made.")
    } else {
        base.to_string()
    }
}

/// Stable identity for a tool call (name + arguments) used for dedup and loop detection.
fn tool_call_key(name: &str, arguments: &str) -> String {
    let normalized_args = serde_json::from_str::<Value>(arguments)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| arguments.trim().to_string());
    format!("{name}:{normalized_args}")
}

fn tool_name_of(tool: &Value) -> &str {
    tool.get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("")
}

/// Tools that run commands/edit state; never selected blindly for read-only insight asks.
const GUARDED_TOOLS: &[&str] = &[
    "run_in_terminal",
    "runInTerminal",
    "runCommands",
    "runCommand",
    "runTask",
    "createAndRunTask",
    "sendToTerminal",
    "executePrompt",
    "runNotebookCell",
];

fn is_guarded_tool(name: &str) -> bool {
    GUARDED_TOOLS.contains(&name)
}

/// Tools that create/modify files or workspace state; never selected for read-only asks.
const MUTATING_TOOLS: &[&str] = &[
    "editFiles",
    "insertEdit",
    "insert_edit_into_file",
    "applyPatch",
    "createFile",
    "createDirectory",
    "multiReplaceString",
    "replaceString",
    "editNotebook",
    "createJupyterNotebook",
    "newWorkspace",
];

fn is_mutating_tool(name: &str) -> bool {
    MUTATING_TOOLS.contains(&name)
}

/// True when the request/plan explicitly calls for running commands or using a terminal.
fn wants_command_execution(reason_text: &str, user_query: &str) -> bool {
    let corpus = format!("{reason_text}\n{user_query}").to_lowercase();
    const EXEC_TERMS: &[&str] = &[
        "run ", "execute", "terminal", "command", "shell", "bash",
        "npm ", "pnpm ", "cargo ", "build", "compile", "install", "script",
    ];
    EXEC_TERMS.iter().any(|t| corpus.contains(t))
}

/// True when the request/plan explicitly asks to create, edit, or otherwise modify files.
fn wants_file_modification(reason_text: &str, user_query: &str) -> bool {
    let corpus = format!("{reason_text}\n{user_query}").to_lowercase();
    const MODIFY_TERMS: &[&str] = &[
        "edit", "modify", "change", "update", "write", "create", "add ", "append",
        "refactor", "rename", "implement", "insert", "replace", "patch", "delete",
        "remove", "fix ", "generate",
    ];
    MODIFY_TERMS.iter().any(|t| corpus.contains(t))
}

/// Path-like argument keys checked for workspace containment.
const PATH_ARG_KEYS: &[&str] = &[
    "path", "filePath", "file", "uri", "directory", "dirPath", "targetFile", "destination",
];

/// True when every path-like argument stays inside the workspace (relative, no traversal).
fn args_paths_within_workspace(arguments: &str, has_roots: bool) -> bool {
    if !has_roots {
        return true;
    }
    let Ok(args_val) = serde_json::from_str::<Value>(arguments) else {
        return true;
    };
    let Some(obj) = args_val.as_object() else {
        return true;
    };
    for (key, value) in obj {
        if PATH_ARG_KEYS.contains(&key.as_str()) {
            if let Value::String(s) = value {
                if !is_workspace_relative(s) {
                    return false;
                }
            }
        }
    }
    true
}

/// True when a path is workspace-relative (not absolute, drive/scheme-qualified, or parent-escaping).
fn is_workspace_relative(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        return false;
    }
    if normalized.starts_with('/') || normalized.starts_with("~") {
        return false;
    }
    if normalized.contains(':') {
        return false;
    }
    !normalized.split('/').any(|seg| seg == "..")
}

/// Collects identity keys for tool calls already issued earlier in the conversation.
fn prior_tool_call_keys(messages: &[ChatMessage]) -> std::collections::HashSet<String> {
    let mut keys = std::collections::HashSet::new();
    for msg in messages {
        if let Some(calls) = &msg.tool_calls {
            for call in calls {
                keys.insert(tool_call_key(&call.function.name, &call.function.arguments));
            }
        }
    }
    keys
}

/// Counts tool-result messages already present (one per executed tool call).
fn count_prior_tool_results(messages: &[ChatMessage]) -> usize {
    messages.iter().filter(|m| m.role == "tool").count()
}

/// Heuristic substrings that mark a hallucinated/placeholder argument value.
const PLACEHOLDER_MARKERS: &[&str] = &[
    "pattern_to", "_to_search", "to_search_for", "to_include", "placeholder",
    "your_", "example_", "<", ">", "todo", "xxx", "foo_bar",
];

fn looks_like_placeholder(value: &str, key: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_lowercase();
    if lower == key.to_lowercase() || lower == "string" || lower == "value" {
        return true;
    }
    PLACEHOLDER_MARKERS.iter().any(|m| lower.contains(m))
}

/// Validates that bound arguments are concrete: required fields present and no placeholder values.
fn tool_call_args_are_concrete(tool: &Value, arguments: &str) -> bool {
    let Ok(args_val) = serde_json::from_str::<Value>(arguments) else {
        return false;
    };
    let Some(obj) = args_val.as_object() else {
        return false;
    };
    let function = tool.get("function");
    let tool_name = function
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let params = function.and_then(|f| f.get("parameters"));
    let required: Vec<String> = params
        .and_then(|p| p.get("required"))
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    for key in &required {
        match obj.get(key) {
            None => return false,
            Some(Value::String(s)) if looks_like_placeholder(s, key) => return false,
            Some(Value::Null) => return false,
            _ => {}
        }
    }
    // Any provided string value that looks like a placeholder, or that just
    // echoes the tool's own name (e.g. command="run_in_terminal"), marks a
    // blind/hallucinated call.
    for (key, value) in obj {
        if let Value::String(s) = value {
            if looks_like_placeholder(s, key) {
                return false;
            }
            if !tool_name.is_empty() && s.trim() == tool_name {
                return false;
            }
        }
    }
    true
}

/// Max chars of the plan/query/context forwarded into bind prompts (keeps within the bind slot context).
const MAX_BIND_PLAN_CHARS: usize = 4_000;
const MAX_BIND_QUERY_CHARS: usize = 2_000;
const MAX_BIND_CONTEXT_CHARS: usize = 3_000;
const MAX_BIND_TOOL_RESULTS_CHARS: usize = 1_500;
const MAX_BIND_TOOL_RESULTS_ARGS_CHARS: usize = 6_000;
const MAX_TOOL_DESC_CHARS: usize = 160;
/// Safety cap on agentic tool rounds before forcing a final answer.
const MAX_PRIOR_TOOL_ROUNDS: usize = 12;

/// Truncates a string to at most `max` chars on a char boundary, appending an ellipsis when cut.
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// Builds a compact `- name: description` list so the bind prompt avoids the full tool JSON schemas.
fn compact_tool_summaries(tools: &[Value]) -> String {
    let mut lines = Vec::with_capacity(tools.len());
    for tool in tools {
        let Some(function) = tool.get("function") else {
            continue;
        };
        let Some(name) = function.get("name").and_then(|n| n.as_str()) else {
            continue;
        };
        let desc = function
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("");
        if desc.is_empty() {
            lines.push(format!("- {name}"));
        } else {
            lines.push(format!(
                "- {name}: {}",
                truncate_chars(desc, MAX_TOOL_DESC_CHARS)
            ));
        }
    }
    lines.join("\n")
}

/// Renders a tool's parameters as `- name (type, required): description` lines for the bind prompt.
fn describe_tool_parameters(tool: &Value) -> String {
    let Some(params) = tool.get("function").and_then(|f| f.get("parameters")) else {
        return "(no parameters)".into();
    };
    let Some(props) = params.get("properties").and_then(|p| p.as_object()) else {
        return "(no parameters)".into();
    };
    if props.is_empty() {
        return "(no parameters)".into();
    }
    let required: std::collections::HashSet<&str> = params
        .get("required")
        .and_then(|r| r.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let mut lines = Vec::with_capacity(props.len());
    for (name, schema) in props {
        let ty = schema
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("any");
        let req = if required.contains(name.as_str()) {
            "required"
        } else {
            "optional"
        };
        let desc = schema
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("");
        if desc.is_empty() {
            lines.push(format!("- {name} ({ty}, {req})"));
        } else {
            lines.push(format!(
                "- {name} ({ty}, {req}): {}",
                truncate_chars(desc, MAX_TOOL_DESC_CHARS)
            ));
        }
    }
    lines.join("\n")
}

/// Builds the stage-two bind user prompt including workspace context and prior tool results.
fn build_stage_two_user_prompt(
    query_excerpt: &str,
    plan_excerpt: &str,
    context_excerpt: &str,
    selected_name: &str,
    params_block: &str,
    prior_messages: &[ChatMessage],
) -> String {
    let context_block = if context_excerpt.trim().is_empty() {
        String::new()
    } else {
        format!("\n\nWorkspace context:\n{context_excerpt}")
    };
    let prefer_path = infer_prefer_path(plan_excerpt, query_excerpt, context_excerpt);
    let tool_results_block = format_tool_results_section(
        prior_messages,
        MAX_BIND_TOOL_RESULTS_ARGS_CHARS,
        prefer_path.as_deref(),
    );
    format!(
        "User request:\n{query_excerpt}\n\nAssistant plan:\n{plan_excerpt}{context_block}{tool_results_block}\n\nTool `{selected_name}` parameters:\n{params_block}\n\nFill the arguments for the tool `{selected_name}` as JSON with fields name and arguments. Set each argument to a concrete value taken from the plan, the user request, the workspace context, and recent tool results (for example real file paths, exact file content for edits, and real search terms). Never echo a parameter's name or the tool name as its value, and never use placeholders like pattern_to_search_for or example values."
    )
}

/// Returns a prompt section for recent tool results, or empty when none fit the budget.
fn format_tool_results_section(
    messages: &[ChatMessage],
    max_chars: usize,
    prefer_path: Option<&str>,
) -> String {
    let formatted = format_prior_tool_results(messages, max_chars, prefer_path);
    if formatted.is_empty() {
        String::new()
    } else {
        format!("\n\nRecent tool results:\n{formatted}")
    }
}

struct PriorToolResultEntry {
    name: String,
    content: String,
    matches_path: bool,
    recency: usize,
}

/// Formats prior tool-result messages as compact bullets, most-recent-first.
fn format_prior_tool_results(
    messages: &[ChatMessage],
    max_chars: usize,
    prefer_path: Option<&str>,
) -> String {
    let mut entries = Vec::new();
    for (idx, msg) in messages.iter().enumerate() {
        if msg.role != "tool" {
            continue;
        }
        let name = resolve_tool_result_name(msg, messages);
        let content = message_content_to_string(msg);
        let matches_path = prefer_path
            .map(|path| tool_result_matches_path(msg, messages, path, &content))
            .unwrap_or(false);
        entries.push(PriorToolResultEntry {
            name,
            content,
            matches_path,
            recency: idx,
        });
    }
    entries.sort_by(|a, b| {
        b.matches_path
            .cmp(&a.matches_path)
            .then(b.recency.cmp(&a.recency))
    });

    let mut lines = Vec::new();
    let mut used = 0usize;
    for entry in entries {
        let line = format!("- {}: {}", entry.name, entry.content);
        let line_len = line.chars().count();
        if used + line_len > max_chars {
            if lines.is_empty() {
                lines.push(truncate_chars(&line, max_chars));
                break;
            }
            break;
        }
        used += line_len;
        lines.push(line);
    }
    lines.join("\n")
}

/// Resolves the tool name for a tool-result message.
fn resolve_tool_result_name(msg: &ChatMessage, messages: &[ChatMessage]) -> String {
    if let Some(name) = &msg.name {
        if !name.is_empty() {
            return name.clone();
        }
    }
    if let Some(id) = &msg.tool_call_id {
        for prior in messages {
            if let Some(calls) = &prior.tool_calls {
                for call in calls {
                    if call.id == *id {
                        return call.function.name.clone();
                    }
                }
            }
        }
    }
    "tool".into()
}

/// True when a tool result corresponds to the preferred path (content or prior call args).
fn tool_result_matches_path(
    msg: &ChatMessage,
    messages: &[ChatMessage],
    prefer_path: &str,
    content: &str,
) -> bool {
    let normalized = prefer_path.replace('\\', "/");
    if content.replace('\\', "/").contains(&normalized) {
        return true;
    }
    let Some(id) = &msg.tool_call_id else {
        return false;
    };
    for prior in messages {
        let Some(calls) = &prior.tool_calls else {
            continue;
        };
        for call in calls {
            if call.id != *id {
                continue;
            }
            if let Ok(args) = serde_json::from_str::<Value>(&call.function.arguments) {
                for key in PATH_ARG_KEYS {
                    if let Some(Value::String(path)) = args.get(*key) {
                        if paths_match(path, prefer_path) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

fn paths_match(left: &str, right: &str) -> bool {
    left.replace('\\', "/") == right.replace('\\', "/")
}

/// Infers a workspace-relative path from plan, query, and context text for stage-two biasing.
fn infer_prefer_path(plan: &str, query: &str, context: &str) -> Option<String> {
    let corpus = format!("{plan}\n{query}\n{context}");
    for token in corpus.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '.' && c != '_' && c != '-');
        if cleaned.is_empty() {
            continue;
        }
        if cleaned.contains('.') && is_workspace_relative(cleaned) {
            return Some(cleaned.to_string());
        }
    }
    None
}

fn build_reason_messages(
    request: &ChatCompletionRequest,
    extra_prompts: &[String],
    local_context: &str,
    tools: &[Value],
) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut system = vec![
        "You are the reasoning half of a coding assistant. A local agent executes tools for you and returns results.".into(),
        "A project overview (name, dependencies, scripts, README) and a workspace file map are provided in the workspace context below. Use them to ground your answer; NEVER ask the user for the project name or other facts already present in the overview, and NEVER ask which files to look at. Instead pick the most relevant files or directories yourself and state the concrete next action.".into(),
        "When you need file contents, a directory listing, search results, diagnostics, dependency manifests, or other local information to answer accurately, describe what you need in ordinary plain prose (for example: I need to read package.json to list dependencies, or I should inspect src/models/ for the model catalog). A local assistant will gather it automatically without further user input.".into(),
        "Do not fabricate file contents. If the provided workspace context is insufficient, describe what local information you still need in plain prose.".into(),
        "If tool results are already present earlier in this conversation, use them to write a complete final answer instead of requesting the same information again.".into(),
        "Do NOT emit tool-call JSON, XML, function-call syntax, or any special structured blocks; reason in natural language only.".into(),
        format!(
            "Tools the local agent can run on your behalf: {}",
            serde_json::to_string(tools).unwrap_or_else(|_| "[]".into())
        ),
    ];
    if !local_context.trim().is_empty() {
        system.push(format!("Relevant workspace context:\n{local_context}"));
    }
    for extra in extra_prompts {
        let trimmed = extra.trim();
        if !trimmed.is_empty() {
            system.push(trimmed.to_string());
        }
    }
    messages.push(json!({ "role": "system", "content": system.join("\n\n") }));
    for msg in &request.messages {
        messages.push(message_to_json(msg));
    }
    messages
}

fn message_to_json(msg: &ChatMessage) -> Value {
    if msg.role == "tool" {
        let name = msg.name.clone().unwrap_or_else(|| "tool".into());
        let text = message_content_to_string(msg);
        return json!({
            "role": "user",
            "content": format!("[Tool result for {name}]\n{text}")
        });
    }
    if msg.role == "assistant" {
        if let Some(calls) = &msg.tool_calls {
            let mut parts = vec![message_content_to_string(msg)];
            for call in calls {
                parts.push(format!(
                    "(prior tool call {} with args {})",
                    call.function.name, call.function.arguments
                ));
            }
            return json!({ "role": "assistant", "content": parts.join("\n") });
        }
    }
    match &msg.content {
        Some(MessageContent::Parts(parts)) => json!({
            "role": msg.role,
            "content": parts.clone()
        }),
        _ => json!({
            "role": msg.role,
            "content": message_content_to_string(msg)
        }),
    }
}

fn build_upstream_reason_body(
    request: &ChatCompletionRequest,
    upstream_model: &str,
    reason_messages: &[Value],
) -> Value {
    let mut body = json!({
        "model": upstream_model,
        "messages": reason_messages,
        "stream": false,
    });
    if let Some(obj) = body.as_object_mut() {
        for (key, value) in &request.extra {
            if matches!(
                key.as_str(),
                "model" | "messages" | "tools" | "tool_choice" | "stream"
            ) {
                continue;
            }
            obj.insert(key.clone(), value.clone());
        }
    }
    body
}

fn last_user_message(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(message_content_to_string)
        .unwrap_or_default()
}

fn message_content_to_string(msg: &ChatMessage) -> String {
    match &msg.content {
        Some(MessageContent::Text(t)) => t.clone(),
        Some(MessageContent::Parts(parts)) => serde_json::to_string(parts).unwrap_or_default(),
        None => String::new(),
    }
}

fn extract_assistant_text(raw: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
        if let Some(content) = parsed
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
        {
            return content.to_string();
        }
    }
    raw.to_string()
}

fn build_non_stream_response(model: &str, outcome: BindOutcome) -> Response {
    let has_tools = !outcome.tool_calls.is_empty();
    let response = ChatCompletionResponse {
        id: format!("chatcmpl-{}", Uuid::new_v4()),
        object: "chat.completion".into(),
        created: now_secs(),
        model: model.into(),
        choices: vec![Choice {
            index: 0,
            message: ChatMessage {
                role: "assistant".into(),
                content: if outcome.content.is_empty() {
                    None
                } else {
                    Some(MessageContent::Text(outcome.content))
                },
                tool_calls: if has_tools {
                    Some(outcome.tool_calls)
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
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&response).unwrap_or_default()))
        .unwrap()
}

fn build_stream_response(model: &str, outcome: BindOutcome) -> Response {
    let stream_id = format!("chatcmpl-{}", Uuid::new_v4());
    let model_owned = model.to_string();
    let body = Body::from_stream(async_stream::stream! {
        let role_chunk = StreamChunk {
            id: stream_id.clone(),
            object: "chat.completion.chunk".into(),
            created: now_secs(),
            model: model_owned.clone(),
            choices: vec![StreamChoice {
                index: 0,
                delta: StreamDelta {
                    role: Some("assistant".into()),
                    content: None,
                    tool_calls: None,
                },
                finish_reason: None,
            }],
        };
        if let Ok(json) = serde_json::to_string(&role_chunk) {
            yield Ok::<_, std::convert::Infallible>(format!("data: {json}\n\n"));
        }

        if !outcome.tool_calls.is_empty() {
            for (i, tc) in outcome.tool_calls.iter().enumerate() {
                let chunk = StreamChunk {
                    id: stream_id.clone(),
                    object: "chat.completion.chunk".into(),
                    created: now_secs(),
                    model: model_owned.clone(),
                    choices: vec![StreamChoice {
                        index: 0,
                        delta: StreamDelta {
                            role: None,
                            content: None,
                            tool_calls: Some(vec![StreamToolCallDelta {
                                index: i as u32,
                                id: Some(tc.id.clone()),
                                call_type: Some("function".into()),
                                function: Some(StreamToolFunctionDelta {
                                    name: Some(tc.function.name.clone()),
                                    arguments: Some(tc.function.arguments.clone()),
                                }),
                            }]),
                        },
                        finish_reason: None,
                    }],
                };
                if let Ok(json) = serde_json::to_string(&chunk) {
                    yield Ok(format!("data: {json}\n\n"));
                }
            }
            let done = StreamChunk {
                id: stream_id.clone(),
                object: "chat.completion.chunk".into(),
                created: now_secs(),
                model: model_owned.clone(),
                choices: vec![StreamChoice {
                    index: 0,
                    delta: StreamDelta {
                        role: None,
                        content: None,
                        tool_calls: None,
                    },
                    finish_reason: Some("tool_calls".into()),
                }],
            };
            if let Ok(json) = serde_json::to_string(&done) {
                yield Ok(format!("data: {json}\n\n"));
            }
        } else {
            for piece in chunk_text_for_stream(&outcome.content, 120) {
                let chunk = StreamChunk {
                    id: stream_id.clone(),
                    object: "chat.completion.chunk".into(),
                    created: now_secs(),
                    model: model_owned.clone(),
                    choices: vec![StreamChoice {
                        index: 0,
                        delta: StreamDelta {
                            role: None,
                            content: Some(piece),
                            tool_calls: None,
                        },
                        finish_reason: None,
                    }],
                };
                if let Ok(json) = serde_json::to_string(&chunk) {
                    yield Ok(format!("data: {json}\n\n"));
                }
            }
            let done = StreamChunk {
                id: stream_id.clone(),
                object: "chat.completion.chunk".into(),
                created: now_secs(),
                model: model_owned.clone(),
                choices: vec![StreamChoice {
                    index: 0,
                    delta: StreamDelta {
                        role: None,
                        content: None,
                        tool_calls: None,
                    },
                    finish_reason: Some("stop".into()),
                }],
            };
            if let Ok(json) = serde_json::to_string(&done) {
                yield Ok(format!("data: {json}\n\n"));
            }
        }
        yield Ok("data: [DONE]\n\n".into());
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body)
        .unwrap()
}

fn chunk_text_for_stream(text: &str, max_chars: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(max_chars.max(1))
        .map(|chunk| chunk.iter().collect())
        .collect()
}

fn resolve_upstream_model(ctx: &AdapterContext, request_model: &str) -> String {
    if let Some(model) = ctx
        .resolved
        .endpoint
        .models
        .iter()
        .find(|m| m.id == request_model)
    {
        if let Some(upstream) = model
            .upstream_model_id
            .as_ref()
            .filter(|id| !id.is_empty())
        {
            return upstream.clone();
        }
    }
    let alias = ctx.orchestrator.orchestrator_model.as_str();
    if request_model == "orchestrator" || request_model == alias {
        if let Some(other) = ctx
            .resolved
            .endpoint
            .models
            .iter()
            .find(|m| m.id != request_model && m.id != "orchestrator" && m.id != alias)
        {
            return other.id.clone();
        }
    }
    request_model.to_string()
}

fn record_audit(ctx: &AdapterContext, model: &str, tool_names: &[String]) {
    use sha2::{Digest, Sha256};
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", model, tool_names.join(",")).as_bytes())
    );
    let entry = AuditEntry {
        timestamp: chrono_now(),
        endpoint_id: ctx.resolved.endpoint.id.clone(),
        model: model.into(),
        upstream_url: redact_text(&ctx.resolved.endpoint.upstream_url),
        redacted_payload_hash: hash,
        emitted_tool_calls: tool_names.to_vec(),
        local_only: ctx.orchestrator.local_only,
    };
    tracing::info!(target: "audit", "{}", serde_json::to_string(&entry).unwrap_or_default());
}

fn chrono_now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
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

    #[test]
    fn builds_reason_messages_with_context() {
        let req = ChatCompletionRequest {
            model: "m".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: Some(MessageContent::Text("fix bug".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            tools: Some(vec![json!({"type":"function","function":{"name":"read_file","parameters":{}}})]),
            tool_choice: None,
            stream: None,
            extra: std::collections::HashMap::new(),
        };
        let msgs = build_reason_messages(&req, &[], "ctx block", &req.tools.clone().unwrap());
        let system = msgs[0]["content"].as_str().unwrap();
        assert!(system.contains("ctx block"));
        assert!(system.contains("local agent"));
        assert!(system.contains("plain prose"));
    }

    #[test]
    fn bind_stage_one_system_biases_toward_tool_call_when_info_needed() {
        let prompt = bind_stage_one_system(false);
        assert!(prompt.contains("actions array"));
        assert!(prompt.contains("read, search, list"));
        assert!(!prompt.contains("already been gathered"));
    }

    #[test]
    fn bind_stage_one_system_prefers_final_when_results_present() {
        let prompt = bind_stage_one_system(true);
        assert!(prompt.contains("already been gathered"));
        assert!(prompt.contains("Never repeat"));
    }

    #[test]
    fn rejects_placeholder_arguments() {
        let tool = json!({
            "type": "function",
            "function": {
                "name": "grep_search",
                "parameters": {
                    "type": "object",
                    "required": ["query"],
                    "properties": { "query": { "type": "string" } }
                }
            }
        });
        assert!(!tool_call_args_are_concrete(&tool, r#"{"query":"pattern_to_search_for"}"#));
        assert!(!tool_call_args_are_concrete(&tool, r#"{"query":""}"#));
        assert!(!tool_call_args_are_concrete(&tool, r#"{"other":"x"}"#));
        assert!(tool_call_args_are_concrete(&tool, r#"{"query":"parseModelsResponse"}"#));
    }

    #[test]
    fn rejects_arguments_that_echo_tool_name() {
        let tool = json!({
            "type": "function",
            "function": {
                "name": "run_in_terminal",
                "parameters": {
                    "type": "object",
                    "required": ["command"],
                    "properties": { "command": { "type": "string" } }
                }
            }
        });
        // The bind model echoing the tool name as the command is a blind call.
        assert!(!tool_call_args_are_concrete(
            &tool,
            r#"{"command":"run_in_terminal"}"#
        ));
        assert!(tool_call_args_are_concrete(
            &tool,
            r#"{"command":"cargo build --release"}"#
        ));
    }

    #[test]
    fn describe_tool_parameters_lists_fields_with_descriptions() {
        let tool = json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "parameters": {
                    "type": "object",
                    "required": ["path"],
                    "properties": {
                        "path": { "type": "string", "description": "File to read" },
                        "limit": { "type": "number" }
                    }
                }
            }
        });
        let described = describe_tool_parameters(&tool);
        assert!(described.contains("- path (string, required): File to read"));
        assert!(described.contains("- limit (number, optional)"));
    }

    #[test]
    fn describe_tool_parameters_handles_no_params() {
        let tool = json!({
            "type": "function",
            "function": { "name": "noop", "parameters": { "type": "object", "properties": {} } }
        });
        assert_eq!(describe_tool_parameters(&tool), "(no parameters)");
    }

    #[test]
    fn guards_execution_tools_unless_requested() {
        assert!(is_guarded_tool("run_in_terminal"));
        assert!(!is_guarded_tool("readFile"));
        assert!(wants_command_execution("I should run the build", "x"));
        assert!(!wants_command_execution("give me insights on these files", "what do they do"));
    }

    #[test]
    fn guards_mutating_tools_unless_modification_requested() {
        assert!(is_mutating_tool("editFiles"));
        assert!(is_mutating_tool("createFile"));
        assert!(!is_mutating_tool("readFile"));
        assert!(wants_file_modification("please refactor the parser", "x"));
        assert!(!wants_file_modification("give me insights on the current files", "explain them"));
    }

    #[test]
    fn rejects_paths_outside_workspace() {
        assert!(is_workspace_relative("src/main.rs"));
        assert!(!is_workspace_relative("/etc/passwd"));
        assert!(!is_workspace_relative("C:/Users/foo/bar.ts"));
        assert!(!is_workspace_relative("../../secret.txt"));
        assert!(!is_workspace_relative("~/notes.md"));

        assert!(args_paths_within_workspace(r#"{"path":"src/a.ts"}"#, true));
        assert!(!args_paths_within_workspace(r#"{"filePath":"/abs/x.ts"}"#, true));
        // No workspace roots configured -> cannot validate, allow through.
        assert!(args_paths_within_workspace(r#"{"filePath":"/abs/x.ts"}"#, false));
    }

    #[test]
    fn prior_tool_call_keys_and_results_from_history() {
        let messages = vec![
            ChatMessage {
                role: "assistant".into(),
                content: None,
                tool_calls: Some(vec![ToolCall {
                    id: "1".into(),
                    call_type: Some("function".into()),
                    function: ToolCallFunction {
                        name: "grep_search".into(),
                        arguments: r#"{"query":"foo"}"#.into(),
                    },
                }]),
                tool_call_id: None,
                name: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: Some(MessageContent::Text("no results".into())),
                tool_calls: None,
                tool_call_id: Some("1".into()),
                name: Some("grep_search".into()),
            },
        ];
        let keys = prior_tool_call_keys(&messages);
        assert!(keys.contains(&tool_call_key("grep_search", r#"{"query":"foo"}"#)));
        assert_eq!(count_prior_tool_results(&messages), 1);
    }

    #[test]
    fn dedupe_tool_calls_removes_identical_entries() {
        let call = ToolCall {
            id: "a".into(),
            call_type: Some("function".into()),
            function: ToolCallFunction {
                name: "readFile".into(),
                arguments: r#"{"path":"src/a.ts"}"#.into(),
            },
        };
        let dup = ToolCall {
            id: "b".into(),
            call_type: Some("function".into()),
            function: ToolCallFunction {
                name: "readFile".into(),
                arguments: r#"{"path":"src/a.ts"}"#.into(),
            },
        };
        let out = dedupe_tool_calls(vec![call, dup]);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn reason_messages_forbid_tool_syntax_and_special_blocks() {
        let req = ChatCompletionRequest {
            model: "m".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: Some(MessageContent::Text("insights".into())),
                tool_calls: None,
                tool_call_id: None,
                name: None,
            }],
            tools: Some(vec![]),
            tool_choice: None,
            stream: None,
            extra: std::collections::HashMap::new(),
        };
        let msgs = build_reason_messages(&req, &[], "", &[]);
        let system = msgs[0]["content"].as_str().unwrap();
        assert!(!system.contains("NEXT_ACTIONS"));
        assert!(system.contains("Do NOT emit tool-call JSON"));
        assert!(system.contains("natural language only"));
    }

    #[test]
    fn chunk_text_for_stream_splits_long_content() {
        let chunks = chunk_text_for_stream("abcdefghij", 3);
        assert_eq!(chunks, vec!["abc", "def", "ghi", "j"]);
    }

    #[test]
    fn parse_stage_two_output_reads_name_and_arguments() {
        let raw = r#"{"name":"readFile","arguments":{"path":"src/main.rs"}}"#;
        let (name, args) = parse_stage_two_output(raw).unwrap();
        assert_eq!(name, "readFile");
        assert!(args.contains("src/main.rs"));
    }

    #[test]
    fn compact_tool_summaries_omit_full_schemas() {
        let tools = vec![
            json!({"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}),
            json!({"type":"function","function":{"name":"no_desc","parameters":{}}}),
        ];
        let summary = compact_tool_summaries(&tools);
        assert!(summary.contains("- read_file: Read a file"));
        assert!(summary.contains("- no_desc"));
        assert!(!summary.contains("parameters"));
        assert!(!summary.contains("properties"));
    }

    #[test]
    fn truncate_chars_caps_long_descriptions() {
        let long = "x".repeat(MAX_TOOL_DESC_CHARS + 50);
        let cut = truncate_chars(&long, MAX_TOOL_DESC_CHARS);
        assert_eq!(cut.chars().count(), MAX_TOOL_DESC_CHARS + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(truncate_chars("short", MAX_TOOL_DESC_CHARS), "short");
    }

    #[test]
    fn format_prior_tool_results_labels_and_orders_most_recent_first() {
        let messages = vec![
            ChatMessage {
                role: "tool".into(),
                content: Some(MessageContent::Text("old content".into())),
                tool_calls: None,
                tool_call_id: Some("1".into()),
                name: Some("readFile".into()),
            },
            ChatMessage {
                role: "tool".into(),
                content: Some(MessageContent::Text("new content".into())),
                tool_calls: None,
                tool_call_id: Some("2".into()),
                name: Some("grep_search".into()),
            },
        ];
        let formatted = format_prior_tool_results(&messages, 10_000, None);
        let grep_pos = formatted.find("grep_search").unwrap();
        let read_pos = formatted.find("readFile").unwrap();
        assert!(grep_pos < read_pos);
        assert!(formatted.contains("- grep_search: new content"));
        assert!(formatted.contains("- readFile: old content"));
    }

    #[test]
    fn format_prior_tool_results_truncates_to_budget() {
        let messages = vec![ChatMessage {
            role: "tool".into(),
            content: Some(MessageContent::Text("x".repeat(500))),
            tool_calls: None,
            tool_call_id: None,
            name: Some("readFile".into()),
        }];
        let formatted = format_prior_tool_results(&messages, 40, None);
        assert!(formatted.chars().count() <= 41);
    }

    #[test]
    fn prefer_path_prioritizes_matching_tool_result_under_tight_budget() {
        let messages = vec![
            ChatMessage {
                role: "assistant".into(),
                content: None,
                tool_calls: Some(vec![ToolCall {
                    id: "1".into(),
                    call_type: Some("function".into()),
                    function: ToolCallFunction {
                        name: "readFile".into(),
                        arguments: r#"{"path":"src/target.ts"}"#.into(),
                    },
                }]),
                tool_call_id: None,
                name: None,
            },
            ChatMessage {
                role: "tool".into(),
                content: Some(MessageContent::Text("target file body".into())),
                tool_calls: None,
                tool_call_id: Some("1".into()),
                name: Some("readFile".into()),
            },
            ChatMessage {
                role: "tool".into(),
                content: Some(MessageContent::Text("unrelated huge ".repeat(20))),
                tool_calls: None,
                tool_call_id: None,
                name: Some("listDir".into()),
            },
        ];
        let formatted =
            format_prior_tool_results(&messages, 80, Some("src/target.ts"));
        assert!(formatted.contains("target file body"));
        assert!(!formatted.contains("unrelated huge"));
    }

    #[test]
    fn prior_results_unlock_mutating_tools_without_explicit_modify_terms() {
        let messages = vec![ChatMessage {
            role: "tool".into(),
            content: Some(MessageContent::Text("file contents".into())),
            tool_calls: None,
            tool_call_id: Some("1".into()),
            name: Some("readFile".into()),
        }];
        let has_prior = count_prior_tool_results(&messages) > 0;
        let wants_modify = wants_file_modification("I'll inspect the file", "go ahead");
        assert!(!wants_modify);
        assert!(has_prior);
        assert!(wants_modify || has_prior);
    }

    #[test]
    fn build_stage_two_user_prompt_includes_tool_results_block() {
        let messages = vec![ChatMessage {
            role: "tool".into(),
            content: Some(MessageContent::Text("export const x = 1;".into())),
            tool_calls: None,
            tool_call_id: None,
            name: Some("readFile".into()),
        }];
        let prompt = build_stage_two_user_prompt(
            "go ahead",
            "edit src/main.ts",
            "",
            "replaceString",
            "- path (string, required)",
            &messages,
        );
        assert!(prompt.contains("Recent tool results:"));
        assert!(prompt.contains("readFile"));
        assert!(prompt.contains("export const x = 1;"));
    }
}
