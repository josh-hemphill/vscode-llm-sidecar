#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRemoteUrl,
  isLlamaRuntimeBundleComplete,
  loadManifest,
  platformArchDir,
  llamaServerExeName,
} from "./asset-lib.mjs";

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = loadManifest(getFlag("--manifest"));
const checkRemote = hasFlag("--check-remote");

const sha256File = async (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const formatStatus = (found, detail = "") =>
  `${found ? "OK" : "MISSING"}${detail ? ` (${detail})` : ""}`;

const rows = [];

const proxyDir = join(root, "bin", platformArchDir());
const proxyName =
  process.platform === "win32" ? "sidecar-proxy.exe" : "sidecar-proxy";
const proxyPath = join(proxyDir, proxyName);
rows.push({
  asset: "sidecar-proxy",
  path: proxyPath,
  status: formatStatus(existsSync(proxyPath)),
});

const llamaPath = join(proxyDir, llamaServerExeName());
const llamaDetail =
  existsSync(llamaPath) && !isLlamaRuntimeBundleComplete(proxyDir)
    ? "incomplete bundle (missing DLLs)"
    : "";
rows.push({
  asset: "llama-server",
  path: llamaPath,
  status: formatStatus(isLlamaRuntimeBundleComplete(proxyDir), llamaDetail),
});

for (const model of manifest.models) {
  const devPath = join(root, ".assets", "models", model.filename);
  let detail = "";
  if (existsSync(devPath)) {
    const digest = await sha256File(devPath);
    detail = `sha256 ${digest.slice(0, 12)}…`;
    if (model.sources[0]?.sha256 && model.sources[0].sha256 !== digest) {
      detail += " MISMATCH";
    }
  }
  rows.push({
    asset: model.id,
    path: devPath,
    status: formatStatus(existsSync(devPath), detail),
  });

  if (hasFlag("--fetch-sha256") && existsSync(devPath) && !model.sources[0]?.sha256) {
    const digest = await sha256File(devPath);
    console.log(`${model.id}: ${digest}`);
  }

  if (checkRemote) {
    for (const src of model.sources) {
      const ok = await checkRemoteUrl(src.url);
      rows.push({
        asset: `${model.id} remote (${src.kind})`,
        path: src.url,
        status: ok ? "OK" : "UNREACHABLE",
      });
    }
  }
}

console.log("\nAsset verification\n");
console.log("Asset\tStatus\tPath");
for (const row of rows) {
  console.log(`${row.asset}\t${row.status}\t${row.path}`);
}

if (hasFlag("--json")) {
  console.log(JSON.stringify(rows, null, 2));
}

const missing = rows.filter((r) => {
  if (hasFlag("--remote-only")) {
    return r.status === "UNREACHABLE";
  }
  return r.status.startsWith("MISSING") || r.status === "UNREACHABLE";
});
process.exitCode = missing.length > 0 ? 1 : 0;
