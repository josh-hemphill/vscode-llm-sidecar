use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// User- or built-in-named tool format rules for text-embedded tool calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFormatProfile {
    #[serde(default = "default_tool_call_open")]
    pub tool_call_open: String,
    #[serde(default = "default_tool_call_close")]
    pub tool_call_close: String,
    #[serde(default = "default_tool_result_open")]
    pub tool_result_open: String,
    #[serde(default = "default_tool_result_close")]
    pub tool_result_close: String,
    #[serde(default = "default_argument_format")]
    pub argument_format: String,
    #[serde(default)]
    pub allow_native_tools: bool,
    #[serde(default = "default_name_attr")]
    pub name_attribute: String,
    #[serde(default = "default_id_attr")]
    pub id_attribute: String,
}

fn default_tool_call_open() -> String {
    "<tool_use>".into()
}
fn default_tool_call_close() -> String {
    "</tool_use>".into()
}
fn default_tool_result_open() -> String {
    "<tool_result>".into()
}
fn default_tool_result_close() -> String {
    "</tool_result>".into()
}
fn default_argument_format() -> String {
    "json-in-body".into()
}
fn default_name_attr() -> String {
    "name".into()
}
fn default_id_attr() -> String {
    "id".into()
}

impl Default for ToolFormatProfile {
    fn default() -> Self {
        Self {
            tool_call_open: default_tool_call_open(),
            tool_call_close: default_tool_call_close(),
            tool_result_open: default_tool_result_open(),
            tool_result_close: default_tool_result_close(),
            argument_format: default_argument_format(),
            allow_native_tools: false,
            name_attribute: default_name_attr(),
            id_attribute: default_id_attr(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDefaults {
    #[serde(default = "default_true")]
    pub tool_calling: bool,
    #[serde(default)]
    pub vision: bool,
    #[serde(default = "default_max_input")]
    pub max_input_tokens: u32,
    #[serde(default = "default_max_output")]
    pub max_output_tokens: u32,
}

fn default_true() -> bool {
    true
}
fn default_max_input() -> u32 {
    128_000
}
fn default_max_output() -> u32 {
    8_192
}

impl Default for CapabilityDefaults {
    fn default() -> Self {
        Self {
            tool_calling: true,
            vision: false,
            max_input_tokens: default_max_input(),
            max_output_tokens: default_max_output(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedProfile {
    #[serde(default)]
    pub tool_format_profile: ToolFormatProfile,
    #[serde(default)]
    pub capability_defaults: CapabilityDefaults,
    /// Extra system messages for inline-xml-tools (after tools preamble, before client messages).
    #[serde(default)]
    pub additional_system_prompts: Vec<String>,
}

pub fn builtin_profiles() -> HashMap<String, NamedProfile> {
    let mut map = HashMap::new();
    map.insert(
        "orchestrated-tools".into(),
        NamedProfile {
            tool_format_profile: ToolFormatProfile::default(),
            capability_defaults: CapabilityDefaults::default(),
            additional_system_prompts: vec![
                "Prefer concrete file paths from the provided workspace context.".into(),
                "When a tool would help, describe which tool and why in plain prose.".into(),
            ],
        },
    );
    map.insert(
        "gemini-non-customtools".into(),
        NamedProfile {
            tool_format_profile: ToolFormatProfile::default(),
            capability_defaults: CapabilityDefaults::default(),
            additional_system_prompts: Vec::new(),
        },
    );
    map
}

pub fn merge_profiles(
    builtin: HashMap<String, NamedProfile>,
    user: HashMap<String, NamedProfile>,
) -> HashMap<String, NamedProfile> {
    let mut out = builtin;
    for (k, v) in user {
        out.insert(k, v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_additional_system_prompts() {
        let json = r#"{
            "toolFormatProfile": {},
            "additionalSystemPrompts": ["Line one", "Line two"]
        }"#;
        let profile: NamedProfile = serde_json::from_str(json).expect("parse");
        assert_eq!(profile.additional_system_prompts.len(), 2);
        assert_eq!(profile.additional_system_prompts[0], "Line one");
    }
}
