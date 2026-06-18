#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installLlamaServer,
  loadManifest,
  platformArchDir,
} from "./asset-lib.mjs";

const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const hasFlag = (name) => args.includes(name);

const variant = getFlag("--variant") ?? "auto";
const manifestPath = getFlag("--manifest");
const platformArch = getFlag("--platform") ?? platformArchDir();
const force = hasFlag("--force");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "bin", platformArch);
mkdirSync(destDir, { recursive: true });

const manifest = loadManifest(manifestPath);
const result = await installLlamaServer(manifest, destDir, {
  variant,
  force,
  platformArch,
  onProgress: (pct) => process.stdout.write(`\rDownloading llama-server… ${pct}%`),
});
console.log(
  `\nllama-server ${result.skipped ? "already present" : "installed"} at ${result.path} (variant: ${result.variant}, platform: ${platformArch})`
);
