# Contributing

## Prerequisites

- Node.js 22+
- pnpm 11+
- Rust stable (for `sidecar-proxy`)
- Optional: NVIDIA GPU drivers (`nvidia-smi`) for CUDA llama-server builds

## Bootstrap

```bash
pnpm install
pnpm run setup:dev      # proxy + llama-server + default model + compile
pnpm run verify:assets  # local asset status table
```

`setup:dev` runs:

1. `build:proxy` — compile and copy `sidecar-proxy` to `bin/<platform>-<arch>/`
2. `fetch:llama-server` — download pinned llama.cpp release (auto-detects GPU variant locally)
3. `fetch:model --id default` — download default US-compliant bind-model GGUF to `.assets/models/`
4. `compile` — bundle the extension to `dist/`

Press **F5** to launch the Extension Development Host. Do **not** install the repo folder itself as an extension — `.assets/` can be multi-GB and will hang the Extensions host.

### Installing a VSIX build

```bash
pnpm run create-vsix
code --install-extension llm-sidecar-0.1.0.vsix
```

The VSIX ships `sidecar-proxy` only (~7 MB). Use **Download Llama Server** after install. Dev models in `.assets/models/` are picked up automatically.

## Asset scripts

| Script | Purpose |
|--------|---------|
| `pnpm run fetch:llama-server` | Download llama-server (`--variant cpu\|cuda12\|…`, `--force`) |
| `pnpm run fetch:model -- --list` | List catalog models |
| `pnpm run fetch:model -- --id phi-4-mini-instruct-q4` | Download a specific model |
| `pnpm run verify:assets` | Print proxy / llama-server / model status |
| `pnpm run verify:assets -- --check-remote --remote-only` | HEAD-check manifest URLs (CI) |
| `pnpm run package:offline -- --tier slim` | Zip binaries + manifest for air-gapped installs |

### HuggingFace gated models

Some catalog repos require HuggingFace login. Export `HF_TOKEN` before running `fetch:model`:

```bash
export HF_TOKEN=hf_…
pnpm run fetch:model -- --id default
```

## US-compliant model catalog

Only Meta Llama 3.2 and Microsoft Phi-4 mini bind models are bundled in `assets/runtime-manifest.json`. Do not add Qwen or other restricted models without explicit policy approval.

## Tests

```bash
pnpm test
node --test scripts/asset-lib.test.mjs
```

See [TESTING.md](TESTING.md) for integration and orchestration testing.
