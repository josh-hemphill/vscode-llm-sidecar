# Testing

```bash
pnpm test                 # Rust + TS + integration
cargo test -p sidecar-proxy
pnpm run test:ts
pnpm run test:integration
node --test scripts/asset-lib.test.mjs
```

## Asset verification

After `pnpm run setup:dev`:

```bash
pnpm run verify:assets
```

Expect `OK` for `sidecar-proxy`, `llama-server`, and the default model in `.assets/models/`.

Remote URL checks (no local binaries required):

```bash
pnpm run verify:assets -- --check-remote --remote-only
```

Integration test spawns `sidecar-proxy`, reloads config, and verifies `/v1/models`.

For end-to-end orchestration testing, run a local `llama-server` on port 8081 with a GGUF model and configure any upstream endpoint. Tool-bearing requests automatically route through bind-and-return regardless of the endpoint adapter.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor bootstrap.
