use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct GrammarPayload {
    #[allow(dead_code)]
    pub tool_set_hash: String,
    pub json_schema: Value,
    #[allow(dead_code)]
    pub gbnf: String,
}

/// Returns a stable hash for the tool definitions in a request.
pub fn hash_tool_set(tools: &[Value]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(tools).unwrap_or_else(|_| "[]".into()).as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Builds a multi-action schema for stage-one selection (0..max tool calls).
pub fn build_action_list_schema(tools: &[Value], max: usize) -> Value {
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
        })
        .collect();
    let max_items = max.max(1);
    json!({
        "type": "object",
        "required": ["actions"],
        "properties": {
            "actions": {
                "type": "array",
                "maxItems": max_items,
                "items": {
                    "type": "object",
                    "required": ["kind", "name"],
                    "properties": {
                        "kind": { "const": "tool_call" },
                        "name": {
                            "type": "string",
                            "enum": names
                        }
                    },
                    "additionalProperties": false
                }
            }
        },
        "additionalProperties": false
    })
}

/// Builds argument schema for a single tool (stage two).
pub fn build_tool_arguments_schema(tool: &Value) -> Value {
    let name = tool
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("unknown");
    let params = tool
        .get("function")
        .and_then(|f| f.get("parameters"))
        .cloned()
        .unwrap_or_else(|| json!({"type":"object","properties":{}}));
    json!({
        "type": "object",
        "required": ["name", "arguments"],
        "properties": {
            "name": { "const": name },
            "arguments": params
        },
        "additionalProperties": false
    })
}

/// Compiles a minimal JSON Schema subset to GBNF (fallback when server lacks json_schema).
pub fn json_schema_to_gbnf(schema: &Value) -> String {
    let mut rules: HashMap<String, String> = HashMap::new();
    let root = compile_schema_node(schema, "root", &mut rules);
    let mut out = String::from("root ::= ");
    out.push_str(&root);
    out.push('\n');
    for (name, rule) in rules {
        out.push_str(&name);
        out.push_str(" ::= ");
        out.push_str(&rule);
        out.push('\n');
    }
    out
}

fn compile_schema_node(schema: &Value, name: &str, rules: &mut HashMap<String, String>) -> String {
    if let Some(one_of) = schema.get("oneOf").and_then(|v| v.as_array()) {
        let alts: Vec<String> = one_of
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let alt_name = format!("{name}_alt{i}");
                compile_schema_node(s, &alt_name, rules)
            })
            .collect();
        return alts.join(" | ");
    }
    if let Some(const_val) = schema.get("const") {
        return json_const_literal(const_val);
    }
    if let Some(enum_vals) = schema.get("enum").and_then(|v| v.as_array()) {
        return enum_vals
            .iter()
            .map(json_const_literal)
            .collect::<Vec<_>>()
            .join(" | ");
    }
    if schema.get("type").and_then(|t| t.as_str()) == Some("string") {
        return r#""([^"\\]|\\.)*""#.into();
    }
    if schema.get("type").and_then(|t| t.as_str()) == Some("object") {
        let props = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .cloned()
            .unwrap_or_default();
        let required: Vec<String> = schema
            .get("required")
            .and_then(|r| r.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let mut parts = vec!["\"{\"".to_string()];
        for (i, key) in required.iter().enumerate() {
            if i > 0 {
                parts.push("\",\" ".into());
            }
            parts.push(format!("\"\\\"{key}\\\":\""));
            if let Some(prop_schema) = props.get(key) {
                let prop_name = format!("{name}_{key}");
                let compiled = compile_schema_node(prop_schema, &prop_name, rules);
                parts.push(compiled);
            } else {
                parts.push("value".into());
            }
        }
        parts.push("\"}\"".into());
        rules.insert("value".into(), r#""([^"\\]|\\.)*""#.into());
        return parts.join(" ");
    }
    r#""([^"\\]|\\.)*""#.into()
}

fn json_const_literal(value: &Value) -> String {
    match value {
        Value::String(s) => format!("\"{s}\""),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        other => format!("\"{}\"", other),
    }
}

/// Parses a grammar-constrained bind output into kind/name/arguments/content.
pub fn parse_bind_output(parsed: &Value) -> Result<BindOutput, String> {
    let kind = parsed
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or_else(|| String::from("missing kind"))?;
    if kind == "final_answer" {
        return Ok(BindOutput::FinalAnswer {
            content: parsed
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    if kind == "tool_call" {
        let name = parsed
            .get("name")
            .and_then(|n| n.as_str())
            .ok_or_else(|| String::from("missing name"))?
            .to_string();
        let arguments = parsed.get("arguments").cloned().unwrap_or(json!({}));
        return Ok(BindOutput::ToolCall {
            name,
            arguments: serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".into()),
        });
    }
    Err(format!("unknown kind: {kind}"))
}

#[derive(Debug, Clone, PartialEq)]
pub enum BindOutput {
    FinalAnswer { content: String },
    ToolCall { name: String, arguments: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_final_answer_bind_output() {
        let parsed: Value = serde_json::from_str(r#"{"kind":"final_answer","content":"done"}"#).unwrap();
        let out = parse_bind_output(&parsed).unwrap();
        assert_eq!(
            out,
            BindOutput::FinalAnswer {
                content: "done".into()
            }
        );
    }

    #[test]
    fn parses_tool_call_bind_output() {
        let parsed: Value = serde_json::from_str(
            r#"{"kind":"tool_call","name":"read_file","arguments":{"path":"src/main.rs"}}"#,
        )
        .unwrap();
        let out = parse_bind_output(&parsed).unwrap();
        assert!(matches!(out, BindOutput::ToolCall { .. }));
    }

    #[test]
    fn hash_tool_set_is_stable() {
        let tools = vec![json!({"type":"function","function":{"name":"a","parameters":{}}})];
        assert_eq!(hash_tool_set(&tools), hash_tool_set(&tools));
    }

    #[test]
    fn action_list_schema_constrains_names_and_max_items() {
        let tools = vec![
            json!({"type":"function","function":{"name":"readFile","parameters":{}}}),
            json!({"type":"function","function":{"name":"textSearch","parameters":{}}}),
        ];
        let schema = build_action_list_schema(&tools, 2);
        let actions = schema
            .get("properties")
            .and_then(|p| p.get("actions"))
            .unwrap();
        assert_eq!(actions.get("maxItems").and_then(|v| v.as_u64()), Some(2));
        let enum_names = actions
            .get("items")
            .and_then(|i| i.get("properties"))
            .and_then(|p| p.get("name"))
            .and_then(|n| n.get("enum"))
            .and_then(|e| e.as_array())
            .unwrap();
        assert_eq!(enum_names.len(), 2);
    }
}
