use crate::config::WorkspaceContext;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const DEFAULT_MAX_CHARS: usize = 12_000;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_WALK_DEPTH: usize = 12;
/// Cap on entries listed in the workspace file map injected into the reason prompt.
const MAX_MAP_FILES: usize = 200;
/// Upper bound on chars spent on the file map so excerpts still fit the context budget.
const MAX_MAP_CHARS: usize = 3_000;
const MAX_FILE_TYPE_ENTRIES: usize = 12;
/// Upper bound on chars for the proactive project overview block.
const MAX_OVERVIEW_CHARS: usize = 1_800;
const MAX_OVERVIEW_DEPS: usize = 24;
const MAX_OVERVIEW_SCRIPTS: usize = 12;
const MAX_README_LINES: usize = 12;
/// Shallow depth for locating root manifests (avoids deep monorepo noise).
const MAX_MANIFEST_DEPTH: usize = 3;

/// Basenames treated as key project manifests or entry points.
const KEY_PROJECT_BASENAMES: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "deno.json",
    "deno.jsonc",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
];

/// Gathers ranked local context snippets for the reason phase (blocking).
pub fn gather_context(
    user_query: &str,
    workspace: &WorkspaceContext,
    max_chars: usize,
) -> String {
    let budget = if max_chars == 0 {
        DEFAULT_MAX_CHARS
    } else {
        max_chars
    };
    let roots = validated_roots(workspace);
    let mut snippets: Vec<(i32, String)> = Vec::new();
    let query_terms: Vec<String> = user_query
        .split_whitespace()
        .filter(|t| t.len() > 2)
        .map(|t| t.to_lowercase())
        .collect();

    for root_path in &roots {
        for entry in WalkDir::new(root_path)
            .max_depth(MAX_WALK_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if is_ignored(path) {
                continue;
            }
            if file_too_large(path) {
                continue;
            }
            let rel = path
                .strip_prefix(root_path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.display().to_string());
            let mut score = score_path(&rel, &query_terms);
            if workspace.open_files.iter().any(|f| f == &rel) {
                score += 50;
            }
            if workspace.recent_files.iter().any(|f| f == &rel) {
                score += 30;
            }
            if score <= 0 {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(path) {
                let excerpt = excerpt_file(&text, &query_terms, 40);
                if !excerpt.is_empty() {
                    snippets.push((score, format!("--- {rel} ---\n{excerpt}")));
                }
            }
        }
    }

    for diag in &workspace.diagnostics {
        snippets.push((
            40,
            format!(
                "DIAG [{}:{}] {} ({})",
                diag.file, diag.line, diag.message, diag.severity
            ),
        ));
    }

    snippets.sort_by(|a, b| b.0.cmp(&a.0));
    let overview = build_project_overview(&roots, (budget / 4).min(MAX_OVERVIEW_CHARS));
    let key_files = build_key_project_files(&roots, 800);
    let file_types = build_file_type_summary(&roots, 400);
    let file_map = build_workspace_map(&roots, (budget / 4).min(MAX_MAP_CHARS));
    let header_budget = overview.len() + key_files.len() + file_types.len() + file_map.len() + 4;
    let excerpt_budget = budget.saturating_sub(header_budget);
    let mut out = String::new();
    if !overview.is_empty() {
        out.push_str(&overview);
        out.push('\n');
    }
    if !key_files.is_empty() {
        out.push_str(&key_files);
        out.push('\n');
    }
    if !file_types.is_empty() {
        out.push_str(&file_types);
        out.push('\n');
    }
    if !file_map.is_empty() {
        out.push_str(&file_map);
        out.push('\n');
    }
    let mut used = 0usize;
    for (_, snippet) in snippets {
        if used + snippet.len() > excerpt_budget {
            break;
        }
        out.push_str(&snippet);
        out.push('\n');
        used += snippet.len() + 1;
    }
    out
}

/// Lists manifest and entry-point files so dependency/key-file questions have anchors.
fn build_key_project_files(roots: &[PathBuf], budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    let mut found: Vec<String> = Vec::new();
    for root_path in roots {
        for entry in WalkDir::new(root_path)
            .max_depth(MAX_WALK_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if is_ignored(path) {
                continue;
            }
            let rel = path
                .strip_prefix(root_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.display().to_string());
            let basename = Path::new(&rel)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if KEY_PROJECT_BASENAMES.contains(&basename)
                || basename.starts_with("README")
                || rel == "src/main.rs"
                || rel == "src/index.ts"
                || rel == "src/index.tsx"
            {
                found.push(rel);
            }
        }
    }
    if found.is_empty() {
        return String::new();
    }
    found.sort();
    found.dedup();
    let mut out = String::from("Key project files:\n");
    for rel in found {
        let line = format!("- {rel}\n");
        if out.len() + line.len() > budget {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// Summarizes file extensions present in the workspace.
fn build_file_type_summary(roots: &[PathBuf], budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    let mut counts: HashMap<String, u32> = HashMap::new();
    for root_path in roots {
        for entry in WalkDir::new(root_path)
            .max_depth(MAX_WALK_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if is_ignored(path) {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("(no ext)")
                .to_lowercase();
            *counts.entry(ext).or_insert(0) += 1;
        }
    }
    if counts.is_empty() {
        return String::new();
    }
    let mut ranked: Vec<(u32, String)> = counts
        .into_iter()
        .map(|(ext, count)| (count, ext))
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    ranked.truncate(MAX_FILE_TYPE_ENTRIES);
    let mut out = String::from("File types (extension counts):\n");
    for (count, ext) in ranked {
        let label = if ext == "(no ext)" {
            format!("(no ext): {count}")
        } else {
            format!(".{ext}: {count}")
        };
        let line = format!("- {label}\n");
        if out.len() + line.len() > budget {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// Reads and summarizes project manifests/README so the reasoning model is grounded up front.
fn build_project_overview(roots: &[PathBuf], budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    let mut sections: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for root_path in roots {
        for entry in WalkDir::new(root_path)
            .max_depth(MAX_MANIFEST_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if is_ignored(path) {
                continue;
            }
            let rel = path
                .strip_prefix(root_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.display().to_string());
            let basename = Path::new(&rel)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let summary = match basename {
                "package.json" => summarize_package_json(path, &rel),
                "deno.json" | "deno.jsonc" => summarize_package_json(path, &rel),
                "Cargo.toml" => summarize_toml_manifest(path, &rel, "package"),
                "pyproject.toml" => summarize_toml_manifest(path, &rel, "project"),
                "go.mod" => summarize_go_mod(path, &rel),
                b if b.starts_with("README") => summarize_readme(path, &rel),
                _ => None,
            };
            if let Some(summary) = summary {
                if seen.len() < 8 && seen.insert(rel.clone()) {
                    sections.push(summary);
                }
            }
        }
    }
    if sections.is_empty() {
        return String::new();
    }
    let mut out = String::from("Project overview (read from manifests; do not ask the user for these facts):\n");
    for section in sections {
        if out.len() + section.len() + 1 > budget {
            break;
        }
        out.push_str(&section);
        out.push('\n');
    }
    out
}

/// Clips a string to at most `max` chars on a char boundary.
fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push('…');
    out
}

/// Joins items with a cap, noting how many were omitted.
fn join_capped(items: &[String], cap: usize) -> String {
    if items.len() <= cap {
        return items.join(", ");
    }
    let shown = items[..cap].join(", ");
    format!("{shown}, …(+{} more)", items.len() - cap)
}

fn object_keys(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

/// Summarizes package.json / deno.json (name, version, description, deps, scripts/tasks).
fn summarize_package_json(path: &Path, rel: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let mut parts = vec![format!("- {rel}")];
    if let Some(name) = value.get("name").and_then(|x| x.as_str()) {
        match value.get("version").and_then(|x| x.as_str()) {
            Some(v) if !v.is_empty() => parts.push(format!("name: {name} v{v}")),
            _ => parts.push(format!("name: {name}")),
        }
    }
    if let Some(desc) = value
        .get("description")
        .and_then(|x| x.as_str())
        .filter(|d| !d.is_empty())
    {
        parts.push(format!("description: {}", clip(desc, 160)));
    }
    let mut deps = object_keys(&value, "dependencies");
    deps.extend(object_keys(&value, "devDependencies"));
    if !deps.is_empty() {
        parts.push(format!("dependencies: {}", join_capped(&deps, MAX_OVERVIEW_DEPS)));
    }
    let mut scripts = object_keys(&value, "scripts");
    scripts.extend(object_keys(&value, "tasks"));
    if !scripts.is_empty() {
        parts.push(format!("scripts: {}", join_capped(&scripts, MAX_OVERVIEW_SCRIPTS)));
    }
    if parts.len() == 1 {
        return None;
    }
    Some(parts.join("\n  "))
}

/// Summarizes a TOML manifest (Cargo.toml/pyproject.toml) via lightweight line scanning.
fn summarize_toml_manifest(path: &Path, rel: &str, meta_section: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut name = None;
    let mut version = None;
    let mut description = None;
    let mut deps: Vec<String> = Vec::new();
    let mut section = String::new();
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('#') || t.is_empty() {
            continue;
        }
        if t.starts_with('[') && t.ends_with(']') {
            section = t.trim_matches(|c| c == '[' || c == ']').to_string();
            if let Some(dep_table) = section.strip_prefix("dependencies.") {
                deps.push(dep_table.to_string());
            }
            continue;
        }
        if section == meta_section {
            if let Some(v) = toml_string_value(t, "name") {
                name = Some(v);
            } else if let Some(v) = toml_string_value(t, "version") {
                version = Some(v);
            } else if let Some(v) = toml_string_value(t, "description") {
                description = Some(v);
            }
        } else if section.ends_with("dependencies") {
            if let Some(key) = t.split('=').next() {
                let key = key.trim();
                if !key.is_empty() && !key.starts_with('[') {
                    deps.push(key.to_string());
                }
            }
        }
    }
    if name.is_none() && deps.is_empty() {
        return None;
    }
    let mut parts = vec![format!("- {rel}")];
    match (name, version) {
        (Some(n), Some(v)) => parts.push(format!("name: {n} v{v}")),
        (Some(n), None) => parts.push(format!("name: {n}")),
        _ => {}
    }
    if let Some(desc) = description {
        parts.push(format!("description: {}", clip(&desc, 160)));
    }
    if !deps.is_empty() {
        deps.dedup();
        parts.push(format!("dependencies: {}", join_capped(&deps, MAX_OVERVIEW_DEPS)));
    }
    Some(parts.join("\n  "))
}

/// Extracts a quoted TOML string value for `key = "..."`.
fn toml_string_value(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim();
    let value = rest.trim_matches('"').trim_matches('\'');
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Summarizes go.mod (module path + go version).
fn summarize_go_mod(path: &Path, rel: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut parts = vec![format!("- {rel}")];
    for line in text.lines() {
        let t = line.trim();
        if let Some(module) = t.strip_prefix("module ") {
            parts.push(format!("module: {}", module.trim()));
        } else if let Some(go) = t.strip_prefix("go ") {
            parts.push(format!("go: {}", go.trim()));
        }
    }
    if parts.len() == 1 {
        return None;
    }
    Some(parts.join("\n  "))
}

/// Summarizes a README by taking its leading non-empty lines.
fn summarize_readme(path: &Path, rel: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let lines: Vec<String> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .take(MAX_README_LINES)
        .map(|l| l.to_string())
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(format!("- {rel}\n  {}", clip(&lines.join(" "), 400)))
}

/// Lists workspace-relative file paths (capped) so the reasoning model knows what exists.
fn build_workspace_map(roots: &[PathBuf], budget: usize) -> String {
    if budget == 0 {
        return String::new();
    }
    let mut ranked: Vec<(i32, String)> = Vec::new();
    for root_path in roots {
        for entry in WalkDir::new(root_path)
            .max_depth(MAX_WALK_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            if is_ignored(path) {
                continue;
            }
            let rel = path
                .strip_prefix(root_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.display().to_string());
            let depth = rel.matches('/').count() as i32;
            let mut score = 100 - depth * 10;
            if rel.ends_with(".rs")
                || rel.ends_with(".ts")
                || rel.ends_with(".tsx")
                || rel.ends_with(".js")
                || rel.ends_with(".py")
                || rel.ends_with(".go")
            {
                score += 15;
            }
            ranked.push((score, rel));
        }
    }
    if ranked.is_empty() {
        return String::new();
    }
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    ranked.truncate(MAX_MAP_FILES);
    ranked.sort_by(|a, b| a.1.cmp(&b.1));
    let mut out = String::from("Workspace file map (relative paths):\n");
    for (_, rel) in ranked {
        let line = format!("- {rel}\n");
        if out.len() + line.len() > budget {
            break;
        }
        out.push_str(&line);
    }
    out
}

/// Async wrapper that runs context gathering off the Tokio runtime.
pub async fn gather_context_async(
    user_query: String,
    workspace: WorkspaceContext,
    max_chars: usize,
) -> String {
    tokio::task::spawn_blocking(move || gather_context(&user_query, &workspace, max_chars))
        .await
        .unwrap_or_default()
}

fn validated_roots(workspace: &WorkspaceContext) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in &workspace.roots {
        let path = Path::new(root);
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if canonical.is_dir() {
            out.push(canonical);
        }
    }
    out
}

fn file_too_large(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.len() > MAX_FILE_BYTES)
        .unwrap_or(true)
}

fn is_ignored(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("node_modules")
        || s.contains(".git")
        || s.contains("target")
        || s.contains("dist")
        || s.ends_with(".lock")
}

fn score_path(rel: &str, terms: &[String]) -> i32 {
    let lower = rel.to_lowercase();
    let mut score = 0;
    for term in terms {
        if lower.contains(term) {
            score += 10;
        }
    }
    if lower.ends_with(".rs") || lower.ends_with(".ts") || lower.ends_with(".tsx") {
        score += 5;
    }
    score
}

fn excerpt_file(text: &str, terms: &[String], context_lines: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut hit_lines: HashSet<usize> = HashSet::new();
    for (i, line) in lines.iter().enumerate() {
        let lower = line.to_lowercase();
        if terms.iter().any(|t| lower.contains(t)) {
            let start = i.saturating_sub(context_lines);
            let end = (i + context_lines + 1).min(lines.len());
            for j in start..end {
                hit_lines.insert(j);
            }
        }
    }
    if hit_lines.is_empty() && !lines.is_empty() {
        let end = 20.min(lines.len());
        return lines[..end].join("\n");
    }
    let mut ordered: Vec<usize> = hit_lines.into_iter().collect();
    ordered.sort_unstable();
    ordered
        .into_iter()
        .map(|i| lines[i])
        .collect::<Vec<_>>()
        .join("\n")
}

/// Fuzzy-corrects a file path against known workspace files.
pub fn ground_file_path(candidate: &str, workspace: &WorkspaceContext) -> String {
    let normalized = candidate.replace('\\', "/");
    let mut best: Option<(i32, String)> = None;
    for root_path in validated_roots(workspace) {
        for entry in WalkDir::new(&root_path)
            .max_depth(MAX_WALK_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let rel = entry
                .path()
                .strip_prefix(&root_path)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let score = path_similarity(&normalized, &rel);
            if score > best.as_ref().map(|(s, _)| *s).unwrap_or(0) {
                best = Some((score, rel));
            }
        }
    }
    best.map(|(_, p)| p).unwrap_or_else(|| normalized)
}

fn path_similarity(a: &str, b: &str) -> i32 {
    if a == b {
        return 100;
    }
    if b.ends_with(a) || a.ends_with(b) {
        return 80;
    }
    if b.contains(a) || a.contains(b) {
        return 60;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DiagnosticHint;

    #[test]
    fn gathers_diagnostics_into_context() {
        let ctx = WorkspaceContext {
            roots: vec![],
            open_files: vec![],
            recent_files: vec![],
            diagnostics: vec![DiagnosticHint {
                file: "src/main.rs".into(),
                line: 10,
                message: "unused variable".into(),
                severity: "warning".into(),
            }],
        };
        let out = gather_context("fix unused", &ctx, 1000);
        assert!(out.contains("unused variable"));
    }

    #[test]
    fn includes_workspace_file_map_for_generic_query() {
        let dir = std::env::temp_dir().join(format!("sidecar-map-{}", std::process::id()));
        let nested = dir.join("src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("alpha.ts"), "export const a = 1;\n").unwrap();
        std::fs::write(dir.join("README.md"), "# project\n").unwrap();
        std::fs::write(dir.join("package.json"), r#"{"name":"demo"}"#).unwrap();

        let ctx = WorkspaceContext {
            roots: vec![dir.to_string_lossy().to_string()],
            open_files: vec![],
            recent_files: vec![],
            diagnostics: vec![],
        };
        let out = gather_context("give me insights about this project", &ctx, 4000);
        assert!(out.contains("Workspace file map"));
        assert!(out.contains("src/alpha.ts"));
        assert!(out.contains("README.md"));
        assert!(out.contains("Key project files"));
        assert!(out.contains("package.json"));
        assert!(out.contains("File types"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn includes_project_overview_from_manifests() {
        let dir = std::env::temp_dir().join(format!("sidecar-overview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"my-sidecar","version":"1.2.3","description":"A demo project","dependencies":{"axum":"0.7"},"scripts":{"build":"x","test":"y"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# My Sidecar\n\nDoes useful things.\n").unwrap();

        let ctx = WorkspaceContext {
            roots: vec![dir.to_string_lossy().to_string()],
            open_files: vec![],
            recent_files: vec![],
            diagnostics: vec![],
        };
        let out = gather_context("what is this project", &ctx, 6000);
        assert!(out.contains("Project overview"));
        assert!(out.contains("my-sidecar"));
        assert!(out.contains("A demo project"));
        assert!(out.contains("axum"));
        assert!(out.contains("scripts:"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn includes_file_type_summary() {
        let dir = std::env::temp_dir().join(format!("sidecar-types-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.ts"), "export const a = 1;\n").unwrap();
        std::fs::write(dir.join("src/b.ts"), "export const b = 2;\n").unwrap();
        std::fs::write(dir.join("notes.md"), "# notes\n").unwrap();

        let ctx = WorkspaceContext {
            roots: vec![dir.to_string_lossy().to_string()],
            open_files: vec![],
            recent_files: vec![],
            diagnostics: vec![],
        };
        let out = gather_context("what file types are in this repo", &ctx, 4000);
        assert!(out.contains("File types"));
        assert!(out.contains(".ts"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
