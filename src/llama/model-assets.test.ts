import assert from "node:assert/strict";
import { test } from "node:test";
import {
  modelCacheFilePath,
  resolveModelSources,
} from "./model-catalog.ts";
import {
  DEFAULT_MODEL_ID,
  getCatalogEntry,
} from "../config/schema.ts";

test("modelCacheFilePath uses catalog filename per model id", () => {
  const llamaPath = modelCacheFilePath(
    "/storage",
    "llama-3.2-3b-instruct-ud-q4",
    "/ext"
  );
  assert.match(llamaPath, /Llama-3\.2-3B-Instruct-UD-Q4_K_XL\.gguf$/);

  const phiPath = modelCacheFilePath("/storage", "phi-4-mini-instruct-q4", "/ext");
  assert.match(phiPath, /microsoft_Phi-4-mini-instruct-Q4_K_M\.gguf$/);
});

test("resolveModelSources prefers verified mirror first", () => {
  const entry = getCatalogEntry(DEFAULT_MODEL_ID)!;
  const hash = entry.sources[0]?.sha256 ?? "";
  const sources = resolveModelSources(
    entry,
    "https://mirror.example/model.gguf",
    hash
  );
  assert.equal(sources[0]?.kind, "mirror");
  assert.equal(sources[0]?.url, "https://mirror.example/model.gguf");
  assert.equal(sources[0]?.sha256, hash);
  assert.equal(sources[1]?.kind, "huggingface");
});

test("resolveModelSources skips mirror without sha256", () => {
  const entry = getCatalogEntry(DEFAULT_MODEL_ID)!;
  const sources = resolveModelSources(entry, "https://mirror.example/model.gguf");
  assert.equal(sources[0]?.kind, "huggingface");
});
