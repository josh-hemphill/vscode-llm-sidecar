import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  copyLlamaRuntimeBundle,
  describeLlamaExitCode,
  isLlamaRuntimeBundleComplete,
  llamaServerBinaryName,
  resolveLlamaBundleRoot,
} from "./runtime-bundle.ts";

const ggmlLibName = (): string =>
  process.platform === "win32" ? "ggml.dll" : "libggml.so";

test("isLlamaRuntimeBundleComplete requires ggml shared lib", () => {
  const dir = join(process.cwd(), ".tmp-runtime-bundle-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, llamaServerBinaryName()), "stub");
  assert.equal(isLlamaRuntimeBundleComplete(dir), false);
  writeFileSync(join(dir, ggmlLibName()), "ggml");
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

test("copyLlamaRuntimeBundle keeps server and libs, drops extra executables", async () => {
  const extractDir = join(process.cwd(), ".tmp-runtime-extract");
  const installDir = join(process.cwd(), ".tmp-runtime-install");
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const exeName = llamaServerBinaryName();
  writeFileSync(join(extractDir, exeName), "exe");
  writeFileSync(join(extractDir, "llama-cli"), "cli");
  writeFileSync(join(extractDir, "llama-bench"), "bench");
  writeFileSync(join(extractDir, ggmlLibName()), "ggml");
  if (process.platform === "win32") {
    writeFileSync(join(extractDir, "llama-server-impl.dll"), "impl");
  }
  const copied = await copyLlamaRuntimeBundle(extractDir, installDir);
  const expected = process.platform === "win32" ? 3 : 2;
  assert.equal(copied, expected);
  const installed = readdirSync(installDir).sort();
  assert.ok(installed.includes(exeName));
  assert.ok(installed.includes(ggmlLibName()));
  assert.ok(!installed.includes("llama-cli"));
  assert.ok(!installed.includes("llama-bench"));
  assert.equal(isLlamaRuntimeBundleComplete(installDir), true);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
});

test("resolveLlamaBundleRoot unwraps single top-level directory", () => {
  const extractDir = join(process.cwd(), ".tmp-runtime-wrapper");
  const wrapperDir = join(extractDir, "llama-b9283");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(wrapperDir, llamaServerBinaryName()), "exe");
  assert.equal(resolveLlamaBundleRoot(extractDir), wrapperDir);
  rmSync(extractDir, { recursive: true, force: true });
});

test("copyLlamaRuntimeBundle flattens wrapped tar layout", async () => {
  const extractDir = join(process.cwd(), ".tmp-runtime-wrapper-extract");
  const installDir = join(process.cwd(), ".tmp-runtime-wrapper-install");
  const wrapperDir = join(extractDir, "llama-b9283");
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(wrapperDir, { recursive: true });
  const exeName = llamaServerBinaryName();
  writeFileSync(join(wrapperDir, exeName), "exe");
  writeFileSync(join(wrapperDir, ggmlLibName()), "ggml");
  if (process.platform === "win32") {
    writeFileSync(join(wrapperDir, "llama-server-impl.dll"), "impl");
  } else {
    writeFileSync(join(wrapperDir, "libllama-server-impl.so"), "impl");
  }
  const copied = await copyLlamaRuntimeBundle(extractDir, installDir);
  const expected = process.platform === "win32" ? 3 : 3;
  assert.equal(copied, expected);
  assert.equal(isLlamaRuntimeBundleComplete(installDir), true);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
});
