use serde_json::Value;
use std::collections::HashSet;

/// Core navigation tools receive a score boost when ranking candidates.
const CORE_NAV_TOOLS: &[&str] = &[
    "readFile",
    "listDirectory",
    "fileSearch",
    "textSearch",
    "codebase",
    "usages",
];

/// Scores and caps the tool set forwarded to bind stage one.
pub fn select_candidate_tools(
    reason_text: &str,
    user_query: &str,
    tools: &[Value],
    max: usize,
) -> Vec<Value> {
    if tools.is_empty() {
        return vec![];
    }
    let cap = max.max(1);
    let corpus = format!("{reason_text}\n{user_query}").to_lowercase();
    let terms = query_terms(&corpus);

    let mut scored: Vec<(i32, Value)> = Vec::new();
    for tool in tools {
        let Some(name) = tool_name(tool) else {
            continue;
        };
        let desc = tool_description(tool).to_lowercase();
        let haystack = format!("{name} {desc}");
        let mut score = score_overlap(&haystack, &terms);
        if CORE_NAV_TOOLS.contains(&name) {
            score += 25;
        }
        if score > 0 {
            scored.push((score, tool.clone()));
        }
    }

    if scored.is_empty() {
        return tools.to_vec();
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| tool_name(&a.1).cmp(&tool_name(&b.1))));

    let mut picked: Vec<Value> = Vec::new();
    let mut seen = HashSet::new();
    for (_, tool) in scored {
        let Some(name) = tool_name(&tool) else {
            continue;
        };
        if seen.insert(name.to_string()) {
            picked.push(tool);
        }
        if picked.len() >= cap {
            break;
        }
    }
    if picked.is_empty() {
        tools.to_vec()
    } else {
        picked
    }
}

fn query_terms(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '/' && c != '.')
        .filter(|t| t.len() > 2)
        .map(|t| t.to_lowercase())
        .collect()
}

fn score_overlap(haystack: &str, terms: &[String]) -> i32 {
    let lower = haystack.to_lowercase();
    terms.iter().filter(|t| lower.contains(t.as_str())).count() as i32 * 10
}

fn tool_name(tool: &Value) -> Option<&str> {
    tool.get("function")
        .and_then(|f| f.get("name"))
        .and_then(|n| n.as_str())
}

fn tool_description(tool: &Value) -> &str {
    tool.get("function")
        .and_then(|f| f.get("description"))
        .and_then(|d| d.as_str())
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_tools() -> Vec<Value> {
        (0..20)
            .map(|i| {
                json!({
                    "type": "function",
                    "function": {
                        "name": format!("tool_{i}"),
                        "description": format!("generic tool number {i}")
                    }
                })
            })
            .chain([
                json!({
                    "type": "function",
                    "function": {
                        "name": "readFile",
                        "description": "Read the contents of a file"
                    }
                }),
                json!({
                    "type": "function",
                    "function": {
                        "name": "textSearch",
                        "description": "Search workspace text"
                    }
                }),
            ])
            .collect()
    }

    #[test]
    fn includes_read_file_for_file_query() {
        let tools = sample_tools();
        let picked = select_candidate_tools("read src/foo.ts for insights", "explain this file", &tools, 12);
        let names: Vec<&str> = picked
            .iter()
            .filter_map(|t| tool_name(t))
            .collect();
        assert!(names.contains(&"readFile"));
    }

    #[test]
    fn respects_cap() {
        let tools = sample_tools();
        let picked = select_candidate_tools("read search list files", "workspace", &tools, 5);
        assert!(picked.len() <= 5);
    }

    #[test]
    fn falls_back_to_full_set_when_nothing_scores() {
        let tools = vec![json!({
            "type": "function",
            "function": { "name": "zzzz", "description": "zzzz" }
        })];
        let picked = select_candidate_tools("???", "???", &tools, 12);
        assert_eq!(picked.len(), 1);
    }
}
