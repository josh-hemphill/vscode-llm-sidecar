# Changelog

## 0.1.1

- Optimize llama args, fix prompt, fix bundle

## 0.1.0

- Initial release: bind-and-return tool orchestration via llama.cpp
- Universal bind-and-return: any tool-bearing request routes through local bind; upstream reasons in prose only
- `orchestrated-tools` adapter (reason-then-bind with grammar-constrained binding)
- Local context gathering (workspace files, diagnostics)
- DLP redaction, audit log, egress allowlist, local-only mode
- Human-in-the-Loop enforcement for VS Code chat tool approval settings
- BYOK sync to `chatLanguageModels.json`
