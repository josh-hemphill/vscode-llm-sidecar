import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keepLlamaRuntimeFile } from "./llama-runtime-files.mjs";

/** Copies downloaded CI artifacts into bin/<platform>/ for vsce package. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const artifactsDir = args.find((a) => !a.startsWith("--")) ?? join(root, "artifacts");
const platform = getFlag("--platform");

if (!platform) {
  console.error("layout-release-binaries: --platform is required (e.g. linux-x64)");
  process.exit(1);
}

const shouldKeep = (name) =>
  name.startsWith("sidecar-proxy") || keepLlamaRuntimeFile(name, platform);

let copied = 0;
const destDir = join(root, "bin", platform);
mkdirSync(destDir, { recursive: true });

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!shouldKeep(name)) {
      continue;
    }
    const dest = join(destDir, name);
    cpSync(full, dest);
    copied += 1;
    console.log(`layout-release-binaries: ${dest}`);
  }
};

if (existsSync(artifactsDir)) {
  walk(artifactsDir);
} else {
  console.warn(`layout-release-binaries: no artifacts at ${artifactsDir}`);
}

if (copied === 0) {
  console.error(
    `layout-release-binaries: no sidecar or llama binaries found for ${platform}`
  );
  process.exit(1);
}
