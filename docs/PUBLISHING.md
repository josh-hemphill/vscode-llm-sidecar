# Publishing

## Architecture: what ships where

LLM Sidecar uses **bind-and-return** tool orchestration: the upstream reasoning model never receives structured tool calls; the local bind model synthesizes them and Copilot executes tools with Human-in-the-Loop approval. Any request with tools uses this path regardless of endpoint adapter.

| Asset | In VSIX (Marketplace / Open VSX / GitHub Release) | Post-install download |
|-------|---------------------------------------------------|------------------------|
| Extension JS (`dist/extension.js`) | Yes | — |
| `assets/runtime-manifest.json` | Yes | — |
| `sidecar-proxy` (per-platform VSIX under `bin/<platform>/`) | Yes | — |
| Minimal `llama-server` runtime (server + shared libs for that platform) | Yes (per-platform VSIX) | **LLM Sidecar: Download Llama Server** or `pnpm run fetch:llama-server` (dev / refresh) |
| Bind-model GGUF | No | **LLM Sidecar: Download Bind Model** or `pnpm run fetch:model` |
| Offline bundle zip | GitHub Release only | Air-gapped installs |

Manifest pin: `assets/runtime-manifest.json` (llama.cpp tag + US-compliant bind-model catalog).

## Supported platforms

Each release ships **one VSIX per platform**:

- `linux-x64`
- `win32-x64`
- `darwin-x64`
- `darwin-arm64`

Other VS Code targets (e.g. `linux-arm64`, `win32-arm64`) are unsupported. The extension is bundle-only for the proxy (no runtime download fallback); users on unsupported platforms see “no compatible version.”

## Expected VSIX layout

After `vsce package --target <platform>`, each VSIX should contain **only that platform’s** binaries:

```
extension/
  dist/extension.js
  dist/extension.js.map
  assets/runtime-manifest.json
  bin/linux-x64/sidecar-proxy          # example: linux-x64 VSIX only
  bin/linux-x64/llama-server
  bin/linux-x64/libggml*.so            # shared libs required at runtime
  package.json
  README.md
  LICENSE
  CHANGELOG.md
```

The minimal llama runtime includes `llama-server` (or `llama-server.exe`) plus **all** shared libraries (`*.dll`, `*.so*`, `*.dylib`). Extra llama.cpp executables (`llama-cli`, `llama-bench`, etc.) are not bundled.

Verify locally:

```bash
pnpm run build
node scripts/layout-release-binaries.mjs artifacts/linux-x64 --platform linux-x64
pnpm run create-vsix -- --target linux-x64
npx @vscode/vsce ls --tree llm-sidecar-linux-x64.vsix
```

Confirm `bin/<platform>/` contains `sidecar-proxy` and the minimal llama-server runtime (not the full llama.cpp archive). CI runs `vsce ls --tree` per platform before marketplace publish.

## VSIX (local build)

```bash
pnpm run build
node scripts/layout-release-binaries.mjs artifacts/<platform> --platform <platform>
node scripts/create-vsix.mjs --target <platform>
```

Release VSIXes are built by [.github/workflows/release.yml](../.github/workflows/release.yml) on `v*` tags (matrix over all four platforms).

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

Bump versions before tagging:

```bash
pnpm run bump:patch -- --message "Short release note"
# or: pnpm run bump:minor / pnpm run bump:major
# or: pnpm run bump:version -- 1.2.3 --message "..."
git add package.json crates/sidecar-proxy/Cargo.toml CHANGELOG.md
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

`scripts/bump-version.mjs` keeps `package.json`, `crates/sidecar-proxy/Cargo.toml`, and `CHANGELOG.md` in sync. Add `--tag` to create the git tag after bumping (still requires commit + push). Use `--dry-run` to preview.

Push a version tag (e.g. `v0.1.0`). The `publish-registries` job in `release.yml` (matrix over platforms):

1. Downloads `llm-sidecar-vsix-<platform>` from `package-vsix`
2. Verifies contents with `vsce ls --tree`
3. Publishes each platform VSIX to Visual Studio Marketplace (unsigned) via `scripts/publish-marketplace.sh`
4. Publishes each platform VSIX to Open VSX as a **stable** release (no `--pre-release`)

`publish-registries` runs in parallel with `publish-release` (GitHub Release assets). Both depend on `package-vsix`.

### Manual publish fallback

```bash
export VSCE_PAT=…
export OVSX_PAT=…
pnpm run create-vsix -- --target linux-x64
bash scripts/publish-marketplace.sh llm-sidecar-linux-x64.vsix
ovsx publish llm-sidecar-linux-x64.vsix -p "$OVSX_PAT"
```

Repeat for each supported platform VSIX.

## Release assets (GitHub)

| Asset | Delivery |
|-------|----------|
| `llm-sidecar-<platform>.vsix` (four platforms) | GitHub Release + both marketplaces |
| `llm-sidecar-offline-<platform>-slim.zip` | GitHub Release only |

## Air-gapped installs

**Slim offline bundle** (CI artifact):

1. Extract `llm-sidecar-offline-<platform>-slim.zip`
2. Install the matching platform VSIX from the GitHub Release, Marketplace, or Open VSX
3. Copy `bin/` into the extension directory or set `llmSidecar.orchestrator.llamaServerBinaryPath`
4. Run `node fetch-model.mjs --id default` with `HF_TOKEN` or pre-seed `.assets/models/` and set `llmSidecar.orchestrator.modelPath`

The offline bundle includes the same minimal llama-server runtime (server + shared libs) as the VSIX, not just the executable.

**Full tier** (`pnpm run package:offline -- --tier full` locally) includes the default GGUF when present in `.assets/models/`.

## Corporate model mirror

Set `llmSidecar.orchestrator.modelMirrorUrl` to an internal HTTPS URL serving the same GGUF artifact. Mirror URL is tried before HuggingFace sources in the manifest.

## Contributor setup

See [CONTRIBUTING.md](CONTRIBUTING.md) for `pnpm run setup:dev` and asset verification.
