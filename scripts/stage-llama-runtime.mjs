#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keepLlamaRuntimeFile } from "./llama-runtime-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const platform = getFlag("--platform");
const srcDir = getFlag("--src") ?? join(root, "bin", platform ?? "");
const destDir = getFlag("--dest") ?? join(root, "artifacts", platform ?? "");

if (!platform) {
  console.error("stage-llama-runtime: --platform is required (e.g. linux-x64)");
  process.exit(1);
}

if (!existsSync(srcDir)) {
  console.error(`stage-llama-runtime: source dir not found: ${srcDir}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });

let copied = 0;
for (const name of readdirSync(srcDir)) {
  const src = join(srcDir, name);
  if (!statSync(src).isFile()) {
    continue;
  }
  if (!keepLlamaRuntimeFile(name, platform)) {
    continue;
  }
  const dest = join(destDir, name);
  cpSync(src, dest);
  copied += 1;
  console.log(`stage-llama-runtime: ${dest}`);
}

if (copied === 0) {
  console.error(`stage-llama-runtime: no llama runtime files staged for ${platform}`);
  process.exit(1);
}
