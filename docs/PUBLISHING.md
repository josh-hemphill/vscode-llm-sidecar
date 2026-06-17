# Publishing

## Architecture: what ships where

LLM Sidecar uses **bind-and-return** tool orchestration: the upstream reasoning model never receives structured tool calls; the local bind model synthesizes them and Copilot executes tools with Human-in-the-Loop approval. Any request with tools uses this path regardless of endpoint adapter.

| Asset | In VSIX (Marketplace / Open VSX / GitHub Release) | Post-install download |
|-------|---------------------------------------------------|------------------------|
| Extension JS (`dist/extension.js`) | Yes | — |
| `assets/runtime-manifest.json` | Yes | — |
| `sidecar-proxy` (all platforms under `bin/<platform>-<arch>/`) | Yes (~7 MB total) | — |
| `llama-server` | No | **LLM Sidecar: Download Llama Server** or `pnpm run fetch:llama-server` |
| Bind-model GGUF | No | **LLM Sidecar: Download Bind Model** or `pnpm run fetch:model` |
| Offline bundle zip | GitHub Release only | Air-gapped installs |

Manifest pin: `assets/runtime-manifest.json` (llama.cpp tag + US-compliant bind-model catalog).

## Expected VSIX layout

After `vsce package`, the VSIX should contain:

```
extension/
  dist/extension.js
  dist/extension.js.map
  assets/runtime-manifest.json
  bin/linux-x64/sidecar-proxy
  bin/win32-x64/sidecar-proxy.exe
  bin/darwin-x64/sidecar-proxy
  bin/darwin-arm64/sidecar-proxy
  package.json
  README.md
  LICENSE
  CHANGELOG.md
```

Verify locally:

```bash
pnpm run build
node scripts/layout-release-binaries.mjs artifacts   # after CI artifact download
pnpm run create-vsix
npx @vscode/vsce ls --tree llm-sidecar-*.vsix
```

Confirm `bin/` contains **only** `sidecar-proxy` binaries (no `llama-server`, no GGUF). CI runs the same `vsce ls --tree` check before marketplace publish.

## VSIX (local build)

```bash
pnpm run build
node scripts/layout-release-binaries.mjs artifacts   # after CI download
npx @vscode/vsce package --no-dependencies
```

Release VSIXes are built by [.github/workflows/release.yml](../.github/workflows/release.yml) on `v*` tags.

## Install links

| Registry | URL |
|----------|-----|
| Visual Studio Marketplace | https://marketplace.visualstudio.com/items?itemName=jo-hemphill.llm-sidecar |
| Open VSX (VSCodium, etc.) | https://open-vsx.org/extension/jo-hemphill/llm-sidecar |
| GitHub Releases | https://github.com/josh-hemphill/vscode-llm-sidecar/releases |

## Marketplace publishing (maintainers)

### Prerequisites

- Publisher **`jo-hemphill`** on [Visual Studio Marketplace](https://marketplace.visualstudio.com/)
- Namespace **`jo-hemphill`** on [Open VSX](https://open-vsx.org/) (separate onboarding from VS Marketplace)
- GitHub Environment **`marketplace`** with secrets:
  - `VSCE_PAT` — Personal Access Token for Visual Studio Marketplace publish
  - `OVSX_PAT` — Open VSX access token

### CI trigger

Push a version tag (e.g. `v0.1.0`). The `publish-registries` job in `release.yml`:

1. Downloads the `llm-sidecar-vsix` artifact from `package-vsix`
2. Verifies contents with `vsce ls --tree`
3. Publishes to Visual Studio Marketplace (unsigned) via `scripts/publish-marketplace.sh`
4. Publishes to Open VSX as a **stable** release (no `--pre-release`)

`publish-registries` runs in parallel with `publish-release` (GitHub Release assets). Both depend on `package-vsix`.

### Manual publish fallback

```bash
export VSCE_PAT=…
export OVSX_PAT=…
pnpm run create-vsix
bash scripts/publish-marketplace.sh llm-sidecar-0.1.0.vsix
ovsx publish llm-sidecar-0.1.0.vsix -p "$OVSX_PAT"
```

## Release assets (GitHub)

| Asset | Delivery |
|-------|----------|
| `llm-sidecar-<version>.vsix` | GitHub Release + both marketplaces |
| `llm-sidecar-offline-<platform>-slim.zip` | GitHub Release only |

## Air-gapped installs

**Slim offline bundle** (CI artifact):

1. Extract `llm-sidecar-offline-<platform>-slim.zip`
2. Install VSIX from the GitHub Release, Marketplace, or Open VSX
3. Copy `bin/` into the extension directory or set `llmSidecar.orchestrator.llamaServerBinaryPath`
4. Run `node fetch-model.mjs --id default` with `HF_TOKEN` or pre-seed `.assets/models/` and set `llmSidecar.orchestrator.modelPath`

**Full tier** (`pnpm run package:offline -- --tier full` locally) includes the default GGUF when present in `.assets/models/`.

## Corporate model mirror

Set `llmSidecar.orchestrator.modelMirrorUrl` to an internal HTTPS URL serving the same GGUF artifact. Mirror URL is tried before HuggingFace sources in the manifest.

## Contributor setup

See [CONTRIBUTING.md](CONTRIBUTING.md) for `pnpm run setup:dev` and asset verification.
