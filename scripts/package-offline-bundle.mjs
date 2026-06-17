#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  getModelEntry,
  loadManifest,
  platformArchDir,
  llamaServerExeName,
} from "./asset-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const tier = getFlag("--tier") ?? "slim";
const modelId = getFlag("--model-id") ?? "default";
const outDir = getFlag("--out") ?? join(root, "artifacts", "offline");
const manifest = loadManifest();
const platform = platformArchDir();

mkdirSync(outDir, { recursive: true });
const bundleDir = join(outDir, `llm-sidecar-offline-${platform}-${tier}`);
mkdirSync(bundleDir, { recursive: true });

const binDest = join(bundleDir, "bin", platform);
mkdirSync(binDest, { recursive: true });

const proxyName =
  process.platform === "win32" ? "sidecar-proxy.exe" : "sidecar-proxy";
const proxySrc = join(root, "bin", platform, proxyName);
const llamaSrc = join(root, "bin", platform, llamaServerExeName());

if (existsSync(proxySrc)) {
  cpSync(proxySrc, join(binDest, proxyName));
}
if (existsSync(llamaSrc)) {
  cpSync(llamaSrc, join(binDest, llamaServerExeName()));
}

cpSync(
  join(root, "assets", "runtime-manifest.json"),
  join(bundleDir, "runtime-manifest.json")
);
cpSync(join(root, "scripts", "fetch-model.mjs"), join(bundleDir, "fetch-model.mjs"));
cpSync(join(root, "scripts", "asset-lib.mjs"), join(bundleDir, "asset-lib.mjs"));

const entry = getModelEntry(manifest, modelId);
if (tier === "full" && entry) {
  const modelSrc = join(root, ".assets", "models", entry.filename);
  if (existsSync(modelSrc)) {
    mkdirSync(join(bundleDir, "models"), { recursive: true });
    cpSync(modelSrc, join(bundleDir, "models", entry.filename));
  }
}

writeFileSync(
  join(bundleDir, "README.txt"),
  [
    "LLM Sidecar offline bundle",
    `Platform: ${platform}`,
    `Tier: ${tier}`,
    "",
    "Install the VSIX separately, then copy bin/ into the extension directory",
    "or set llmSidecar.orchestrator.llamaServerBinaryPath.",
    tier === "slim"
      ? "Run fetch-model.mjs with Node to download the default GGUF."
      : "Default model included in models/ when tier=full.",
    "",
    "Set HF_TOKEN for gated HuggingFace downloads.",
  ].join("\n")
);

const zipName = join(outDir, `llm-sidecar-offline-${platform}-${tier}.zip`);
if (process.platform === "win32") {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${bundleDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipName.replace(/'/g, "''")}' -Force"`,
    { stdio: "inherit" }
  );
} else {
  execSync(`cd "${bundleDir}" && zip -r "${zipName}" .`, { stdio: "inherit" });
}

console.log(`Offline bundle: ${zipName}`);
