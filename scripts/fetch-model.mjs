#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getModelEntry,
  installModel,
  loadManifest,
} from "./asset-lib.mjs";

const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const hasFlag = (name) => args.includes(name);

if (hasFlag("--list")) {
  const manifest = loadManifest(getFlag("--manifest"));
  for (const model of manifest.models) {
    const sizeGb = (model.sizeBytes / 1_000_000_000).toFixed(1);
    console.log(
      `${model.id}${model.isDefault ? " (default)" : ""} — ${model.displayName} (~${sizeGb} GB, ${model.license})`
    );
  }
  process.exit(0);
}

const modelId = getFlag("--id") ?? "default";
const mirrorUrl = getFlag("--mirror") ?? "";
const force = hasFlag("--force");
const manifestPath = getFlag("--manifest");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = loadManifest(manifestPath);
const entry = getModelEntry(manifest, modelId);
if (!entry) {
  console.error(`Unknown model id: ${modelId}`);
  process.exit(1);
}

const destDir = join(root, ".assets", "models");
mkdirSync(destDir, { recursive: true });
const destPath = join(destDir, entry.filename);

const result = await installModel(manifest, modelId, destPath, {
  mirrorUrl,
  force,
  onProgress: (pct) =>
    process.stdout.write(`\rDownloading ${entry.displayName}… ${pct}%`),
});
console.log(
  `\nModel ${result.skipped ? "already present" : "downloaded"} at ${result.path}`
);
