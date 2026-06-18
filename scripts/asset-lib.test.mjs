import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  copyLlamaRuntimeBundle,
  detectLlamaVariant,
  getModelEntry,
  loadManifest,
  platformArchDir,
  resolveLlamaBundleRoot,
  resolveLlamaServerAsset,
  resolveModelSources,
  validateRuntimeManifest,
} from "./asset-lib.mjs";

test("loadManifest parses runtime manifest", () => {
  const manifest = loadManifest();
  assert.equal(manifest.version, 1);
  assert.ok(manifest.llamaServer?.platforms);
  assert.ok(Array.isArray(manifest.models));
  assert.equal(manifest.models.length, 2);
});

test("validateRuntimeManifest accepts bundled manifest", () => {
  const manifest = loadManifest();
  const errors = validateRuntimeManifest(manifest);
  assert.deepEqual(errors, []);
});

test("getModelEntry resolves default model", () => {
  const manifest = loadManifest();
  const entry = getModelEntry(manifest, "default");
  assert.equal(entry.id, "llama-3.2-3b-instruct-ud-q4");
});

test("resolveModelSources prefers verified mirror first", () => {
  const manifest = loadManifest();
  const entry = getModelEntry(manifest, "llama-3.2-3b-instruct-ud-q4");
  const hash = entry.sources[0].sha256;
  const sources = resolveModelSources(
    entry,
    "https://mirror.example/model.gguf",
    hash
  );
  assert.equal(sources[0].kind, "mirror");
  assert.equal(sources[0].url, "https://mirror.example/model.gguf");
  assert.equal(sources[1].kind, "huggingface");
});

test("resolveLlamaServerAsset falls back to cpu", () => {
  const manifest = loadManifest();
  const asset = resolveLlamaServerAsset(manifest, {
    variant: "cuda13",
    platformArch: "win32-x64",
  });
  assert.ok(asset.url.includes("cuda"));
});

test("resolveLlamaServerAsset uses cpu when variant unavailable", () => {
  const manifest = loadManifest();
  const asset = resolveLlamaServerAsset(manifest, {
    variant: "vulkan",
    platformArch: "win32-arm64",
  });
  assert.ok(asset.url.includes("cpu"));
});

test("detectLlamaVariant returns a known variant", () => {
  const variant = detectLlamaVariant();
  assert.ok(["cpu", "cuda12", "cuda13", "vulkan", "metal"].includes(variant));
});

test("platformArchDir matches process", () => {
  assert.equal(platformArchDir(), `${process.platform}-${process.arch}`);
});

test("resolveLlamaBundleRoot unwraps single top-level directory", () => {
  const extractDir = join(process.cwd(), ".tmp-llama-bundle-root");
  const wrapperDir = join(extractDir, "llama-b9283");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(wrapperDir, "llama-server"), "exe");
  assert.equal(resolveLlamaBundleRoot(extractDir), wrapperDir);
  rmSync(extractDir, { recursive: true, force: true });
});

test("copyLlamaRuntimeBundle flattens wrapped tar layout", () => {
  const extractDir = join(process.cwd(), ".tmp-llama-bundle-extract");
  const installDir = join(process.cwd(), ".tmp-llama-bundle-install");
  const wrapperDir = join(extractDir, "llama-b9283");
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(wrapperDir, "llama-server"), "exe");
  writeFileSync(join(wrapperDir, "libllama-server-impl.dylib"), "impl");
  const copied = copyLlamaRuntimeBundle(extractDir, installDir);
  assert.equal(copied, 2);
  assert.ok(existsSync(join(installDir, "llama-server")));
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
});
