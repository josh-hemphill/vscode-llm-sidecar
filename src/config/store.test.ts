import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { proxyBinaryCandidates, resolveProxyBinary } from "./proxy-binary.ts";
import { DEFAULT_ORCHESTRATOR, type LlmSidecarSettings } from "./schema.ts";

const baseSettings = (): LlmSidecarSettings => ({
  proxyPort: 3848,
  autoStartProxy: true,
  autoStartLlama: true,
  autoSyncOnActivate: true,
  proxyBinaryPath: "",
  profilesPath: "",
  modelCachePath: "",
  copilotByokSecretId: "llmSidecar",
  enforceHumanInTheLoop: true,
  profiles: {},
  modelOverrides: {},
  syncTargets: [],
  inlineCompletion: { enabled: false },
  endpoints: [],
  orchestrator: DEFAULT_ORCHESTRATOR,
});

describe("proxyBinaryCandidates", () => {
  it("orders platform bin then flat bin then target release then debug", () => {
    const ext = path.join(os.tmpdir(), "ext-test");
    const candidates = proxyBinaryCandidates(baseSettings(), ext);
    const exe = process.platform === "win32" ? "sidecar-proxy.exe" : "sidecar-proxy";
    const platformArch = `${process.platform}-${process.arch}`;
    assert.ok(candidates[0]?.endsWith(path.join("bin", platformArch, exe)));
    assert.ok(candidates[1]?.endsWith(path.join("bin", exe)));
    assert.ok(candidates[2]?.includes(path.join("target", "release")));
    assert.ok(candidates[3]?.includes(path.join("target", "debug")));
  });
});

describe("resolveProxyBinary", () => {
  const tmpRoot = path.join(os.tmpdir(), `sidecar-bin-${Date.now()}`);

  it("returns first existing candidate", () => {
    const binDir = path.join(tmpRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const exe = process.platform === "win32" ? "sidecar-proxy.exe" : "sidecar-proxy";
    const binFile = path.join(binDir, exe);
    writeFileSync(binFile, "");
    const resolved = resolveProxyBinary(baseSettings(), tmpRoot);
    assert.equal(resolved, binFile);
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});
