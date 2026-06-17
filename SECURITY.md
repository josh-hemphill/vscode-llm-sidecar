# Security

## Threat model

LLM Sidecar is designed for environments that **forbid upstream tool calling** but still need coding-agent workflows. Tool-call **synthesis** (bind) and workspace **context gathering** stay on-device; only redacted reason-phase prompts egress to configured upstreams. The editor executes tools locally with Human-in-the-Loop approval.

## Human-in-the-Loop

When `llmSidecar.enforceHumanInTheLoop` is enabled (default), the extension sets:

- `chat.tools.global.autoApprove` → `false`
- `chat.tools.terminal.enableAutoApprove` → `false`
- `chat.tools.terminal.autoApprove` → `{ "*": false }`
- `chat.tools.eligibleForAutoApproval` → every known tool → `false`

For fleet-wide guarantees, use VS Code enterprise policies (`ChatToolsAutoApprove`, `ChatToolsEligibleForAutoApproval`, `ChatToolsTerminalEnableAutoApprove`).

## DLP and audit

- Outbound upstream payloads pass through regex-based redaction (API keys, bearer tokens, PEM private keys, email addresses).
- Audit entries (endpoint, model, redacted upstream URL, emitted tool names) append to `globalStorage/audit-log.jsonl`.
- View via **LLM Sidecar: View Audit Log**.

## Egress controls

- `llmSidecar.orchestrator.egressAllowlist` — only listed URL prefixes may be contacted.
- `llmSidecar.orchestrator.localOnly` — blocks all upstream calls (bind-only mode).

## Reporting

Report vulnerabilities via GitHub Security Advisories on this repository.
