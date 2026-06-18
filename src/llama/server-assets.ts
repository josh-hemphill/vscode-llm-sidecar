import { execSync, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { LlamaServerVariant } from "../config/schema.ts";
import {
  loadRuntimeManifest,
  type RuntimeManifestLlamaAsset,
} from "../config/runtime-manifest.ts";
import { llamaPlatformArchDir } from "./binary.ts";
import {
  detectLlamaVariant,
  resolveLlamaVariantSetting,
} from "./detect-backend.ts";
import {
  copyLlamaRuntimeBundle,
  isLlamaRuntimeBundleComplete,
} from "./runtime-bundle.ts";
import { sha256File } from "./model-assets.ts";

const llamaServerExeName = (): string =>
  process.platform === "win32" ? "llama-server.exe" : "llama-server";

/** Resolves llama-server install directory from settings. */
export const resolveLlamaServerInstallDir = (
  context: vscode.ExtensionContext,
  installDirSetting: string
): string => {
  const configured = installDirSetting.trim();
  if (configured) {
    return configured;
  }
  return path.join(context.extensionPath, "bin", llamaPlatformArchDir());
};

/** Resolves llama-server asset with variant fallback chain. */
export const resolveLlamaServerAsset = (
  manifest: ReturnType<typeof loadRuntimeManifest>,
  options: {
    variant: LlamaServerVariant;
    platformArch?: string;
  }
): RuntimeManifestLlamaAsset & { variant: string; platformArch: string } => {
  const platformArch = options.platformArch ?? llamaPlatformArchDir();
  const platform = manifest.llamaServer.platforms[platformArch];
  if (!platform) {
    throw new Error(`No llama-server platform entry for ${platformArch}`);
  }

  const detected =
    options.variant === "auto"
      ? detectLlamaVariant()
      : resolveLlamaVariantSetting(options.variant);
  const chain = [
    detected,
    "cuda12",
    "cuda13",
    "vulkan",
    "cpu",
    "metal",
  ] as const;

  for (const variant of chain) {
    const entry = platform[variant];
    if (entry?.url) {
      return { ...entry, variant, platformArch };
    }
  }
  throw new Error(
    `No llama-server variant available for ${platformArch}`
  );
};

const extractArchive = async (
  archivePath: string,
  destDir: string
): Promise<void> => {
  await fs.mkdir(destDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
          ],
          { stdio: "inherit" }
        );
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`))
        );
      });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("unzip", ["-o", "-q", archivePath, "-d", destDir], {
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))
      );
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
    );
  });
};

const findExtractedBinary = async (
  extractDir: string,
  relativePath: string
): Promise<string | undefined> => {
  const direct = path.join(extractDir, relativePath);
  if (existsSync(direct)) {
    return direct;
  }
  const walk = async (dir: string, depth = 0): Promise<string | undefined> => {
    if (depth > 6) {
      return undefined;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (
        entry.name === relativePath ||
        entry.name === llamaServerExeName()
      ) {
        return full;
      }
      if (entry.isDirectory()) {
        const found = await walk(full, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(extractDir);
};

/** Returns whether llama-server binary exists in the install directory. */
export const hasLlamaServerBinary = (
  context: vscode.ExtensionContext,
  installDirSetting: string,
  binaryPathSetting: string
): boolean => {
  const configured = binaryPathSetting.trim();
  if (configured && existsSync(configured)) {
    return true;
  }
  const installDir = resolveLlamaServerInstallDir(context, installDirSetting);
  return isLlamaRuntimeBundleComplete(installDir);
};

/** Downloads and extracts llama-server into the install directory. */
export const downloadLlamaServer = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  options: {
    variant: LlamaServerVariant;
    installDirSetting: string;
    force?: boolean;
  },
  onProgress?: (pct: number) => void
): Promise<{ path: string; variant: string; skipped: boolean }> => {
  const manifest = loadRuntimeManifest(context.extensionPath);
  const asset = resolveLlamaServerAsset(manifest, {
    variant: options.variant,
  });
  const installDir = resolveLlamaServerInstallDir(
    context,
    options.installDirSetting
  );
  const exeDest = path.join(installDir, llamaServerExeName());
  if (isLlamaRuntimeBundleComplete(installDir) && !options.force) {
    log.appendLine(`llama-server already present at ${exeDest}`);
    return { path: exeDest, variant: asset.variant, skipped: true };
  }

  const cacheDir = path.join(
    context.globalStorageUri.fsPath,
    "cache",
    "llama-server"
  );
  await fs.mkdir(cacheDir, { recursive: true });
  const archiveName = asset.url.split("/").pop() ?? "llama.zip";
  const archivePath = path.join(cacheDir, archiveName);
  const extractDir = path.join(
    cacheDir,
    `${asset.platformArch}-${asset.variant}`
  );

  if (options.force && existsSync(archivePath)) {
    await fs.rm(archivePath, { force: true });
  }

  if (!existsSync(archivePath)) {
    log.appendLine(`Downloading llama-server (${asset.variant}) from ${asset.url}`);
    const expectedSha256 = asset.sha256?.trim() ?? "";
    if (!expectedSha256) {
      throw new Error(`llama-server manifest entry missing sha256: ${asset.url}`);
    }
    const res = await fetch(asset.url);
    if (!res.ok || !res.body) {
      throw new Error(`llama-server download failed: ${res.status}`);
    }
    const total = Number(res.headers.get("content-length") ?? 0);
    const reader = res.body.getReader();
    const out = createWriteStream(archivePath);
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        out.write(Buffer.from(value));
        received += value.length;
        if (total > 0 && onProgress) {
          onProgress(Math.round((received / total) * 100));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
    const digest = await sha256File(archivePath);
    if (digest !== expectedSha256.toLowerCase()) {
      await fs.rm(archivePath, { force: true });
      throw new Error(
        `llama-server SHA-256 mismatch (expected ${expectedSha256}, got ${digest})`
      );
    }
  } else {
    const expectedSha256 = asset.sha256?.trim() ?? "";
    if (!expectedSha256) {
      throw new Error(`llama-server manifest entry missing sha256: ${asset.url}`);
    }
    const digest = await sha256File(archivePath);
    if (digest !== expectedSha256.toLowerCase()) {
      await fs.rm(archivePath, { force: true });
      throw new Error(
        `Cached llama-server archive SHA-256 mismatch (expected ${expectedSha256}, got ${digest})`
      );
    }
  }

  await fs.rm(extractDir, { recursive: true, force: true });
  await extractArchive(archivePath, extractDir);
  const found =
    (await findExtractedBinary(extractDir, asset.binaryPathInsideArchive)) ??
    (await findExtractedBinary(extractDir, llamaServerExeName()));
  if (!found) {
    throw new Error(`llama-server binary not found inside ${archivePath}`);
  }

  await fs.mkdir(installDir, { recursive: true });
  const copied = await copyLlamaRuntimeBundle(extractDir, installDir);
  if (!isLlamaRuntimeBundleComplete(installDir)) {
    throw new Error(
      `llama-server bundle incomplete after install (expected ${exeDest})`
    );
  }
  if (process.platform !== "win32") {
    execSync(`chmod +x "${exeDest}"`);
  }
  log.appendLine(
    `llama-server installed at ${exeDest} (variant: ${asset.variant}, ${copied} files)`
  );
  return { path: exeDest, variant: asset.variant, skipped: false };
};
