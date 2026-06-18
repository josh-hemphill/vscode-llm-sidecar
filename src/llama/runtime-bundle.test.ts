import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  copyLlamaRuntimeBundle,
  describeLlamaExitCode,
  isLlamaRuntimeBundleComplete,
  llamaServerBinaryName,
} from "./runtime-bundle.ts";

test("isLlamaRuntimeBundleComplete requires impl dll on Windows", () => {
  const dir = join(process.cwd(), ".tmp-runtime-bundle-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, llamaServerBinaryName()), "stub");
  if (process.platform === "win32") {
    assert.equal(isLlamaRuntimeBundleComplete(dir), false);
    writeFileSync(join(dir, "llama-server-impl.dll"), "impl");
    assert.equal(isLlamaRuntimeBundleComplete(dir), true);
  } else {
    assert.equal(isLlamaRuntimeBundleComplete(dir), true);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("describeLlamaExitCode explains Windows DLL load failures", () => {
  assert.match(describeLlamaExitCode(3221225781) ?? "", /DLL/i);
});

test("copyLlamaRuntimeBundle copies all files from extract dir", async () => {
  const extractDir = join(process.cwd(), ".tmp-runtime-extract");
  const installDir = join(process.cwd(), ".tmp-runtime-install");
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const exeName = llamaServerBinaryName();
  writeFileSync(join(extractDir, exeName), "exe");
  writeFileSync(join(extractDir, "ggml.dll"), "dll");
  if (process.platform === "win32") {
    writeFileSync(join(extractDir, "llama-server-impl.dll"), "impl");
  }
  const copied = await copyLlamaRuntimeBundle(extractDir, installDir);
  assert.equal(copied, process.platform === "win32" ? 3 : 2);
  assert.equal(isLlamaRuntimeBundleComplete(installDir), true);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
});
