#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./asset-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "assets", "runtime-manifest.json");
const manifest = loadManifest();
const tag = manifest.llamaServer?.releaseTag;
if (!tag) {
  console.error("llamaServer.releaseTag is required");
  process.exit(1);
}

const res = await fetch(
  `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`
);
if (!res.ok) {
  console.error(`Release ${tag} not found (${res.status})`);
  process.exit(1);
}

const release = await res.json();
const digestByUrl = new Map();
for (const asset of release.assets ?? []) {
  const digest = asset.digest?.replace(/^sha256:/i, "") ?? "";
  if (asset.browser_download_url && digest) {
    digestByUrl.set(asset.browser_download_url, digest.toLowerCase());
  }
}

let updated = 0;
const missing = [];
for (const [platform, variants] of Object.entries(manifest.llamaServer.platforms)) {
  for (const [variant, entry] of Object.entries(variants)) {
    const digest = digestByUrl.get(entry.url);
    if (!digest) {
      missing.push(`${platform}.${variant}: ${entry.url}`);
      continue;
    }
    if (entry.sha256 !== digest) {
      entry.sha256 = digest;
      updated += 1;
    }
  }
}

if (missing.length > 0) {
  console.error("No GitHub digest for:");
  for (const line of missing) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Synced ${updated} llama-server sha256 pin(s) from ggml-org/llama.cpp release ${tag}`
);
