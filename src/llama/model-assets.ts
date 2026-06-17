import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { OrchestratorModelConfig } from "../config/schema.ts";
import {
  devModelFilePath,
  modelCacheFilePath,
  resolveCatalogEntry,
  resolveModelSources,
} from "./model-catalog.ts";

export type { OrchestratorCatalogEntry } from "../config/schema.ts";
export {
  formatModelSizeGb,
  listOrchestratorModels,
  resolveCatalogEntry,
  resolveModelSources,
} from "./model-catalog.ts";

const MODEL_MANIFEST = "orchestrator-model.json";

export interface ResolvedModelAsset {
  path: string;
  source: "explicit" | "cache" | "dev-cache" | "downloaded";
  modelId: string;
}

/** Returns the cached model path in globalStorage for a model id. */
export const modelCachePath = (
  context: vscode.ExtensionContext,
  modelId?: string
): string =>
  modelCacheFilePath(
    context.globalStorageUri.fsPath,
    modelId,
    context.extensionPath
  );

const manifestPath = (context: vscode.ExtensionContext): string =>
  path.join(context.globalStorageUri.fsPath, MODEL_MANIFEST);

/** Computes SHA-256 hex digest for a file. */
export const sha256File = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });

/** Resolves the orchestrator GGUF path from settings and cache. */
export const resolveModelAsset = async (
  context: vscode.ExtensionContext,
  options: {
    modelPath: string;
    modelMirrorUrl: string;
    modelReleaseAsset: string;
    selectedModelId?: string;
  }
): Promise<ResolvedModelAsset | undefined> => {
  if (options.modelPath.trim() && existsSync(options.modelPath.trim())) {
    return {
      path: options.modelPath.trim(),
      source: "explicit",
      modelId: options.selectedModelId ?? resolveCatalogEntry("", context.extensionPath).id,
    };
  }

  const modelId = options.selectedModelId;
  const entry = resolveCatalogEntry(modelId ?? "", context.extensionPath);
  const cached = modelCachePath(context, entry.id);
  if (existsSync(cached)) {
    return { path: cached, source: "cache", modelId: entry.id };
  }

  const devCached = devModelFilePath(context.extensionPath, entry.id);
  if (existsSync(devCached)) {
    return { path: devCached, source: "dev-cache", modelId: entry.id };
  }

  return undefined;
};

/** Downloads and verifies the orchestrator model into globalStorage. */
export const downloadOrchestratorModel = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  options: {
    modelId: string;
    modelMirrorUrl: string;
    modelReleaseAsset: string;
    modelMirrorSha256?: string;
    expectedSha256?: string;
  },
  onProgress?: (pct: number) => void
): Promise<ResolvedModelAsset> => {
  const entry = resolveCatalogEntry(options.modelId, context.extensionPath);
  const sources = resolveModelSources(
    entry,
    options.modelMirrorUrl,
    options.modelMirrorSha256
  );
  if (sources.length === 0 && options.modelReleaseAsset.trim()) {
    const legacyHash =
      options.expectedSha256?.trim() || entry.sources[0]?.sha256?.trim() || "";
    if (!legacyHash) {
      throw new Error(
        `No verified download source for ${entry.id}; set sha256 in catalog or modelMirrorSha256`
      );
    }
    sources.push({
      kind: "legacy",
      url: options.modelReleaseAsset.trim(),
      sha256: legacyHash,
    });
  }
  if (sources.length === 0) {
    throw new Error(
      `No verified download source for ${entry.id}; catalog entries require sha256`
    );
  }

  const dest = modelCachePath(context, entry.id);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  let lastError: Error | undefined;

  for (const src of sources) {
    try {
      log.appendLine(`Downloading ${entry.displayName} from ${src.url}`);
      const headers: Record<string, string> = {};
      const hfToken = process.env.HF_TOKEN?.trim();
      if (hfToken) {
        headers.Authorization = `Bearer ${hfToken}`;
      }
      const res = await fetch(src.url, { headers });
      if (!res.ok || !res.body) {
        throw new Error(`Model download failed: ${res.status}`);
      }
      const total = Number(res.headers.get("content-length") ?? 0);
      const reader = res.body.getReader();
      const out = createWriteStream(tmp);
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
      const digest = await sha256File(tmp);
      if (src.sha256 !== digest) {
        await fs.rm(tmp, { force: true });
        throw new Error(
          `Model SHA-256 mismatch (expected ${src.sha256}, got ${digest})`
        );
      }
      await fs.rename(tmp, dest);
      await fs.writeFile(
        manifestPath(context),
        `${JSON.stringify(
          {
            id: entry.id,
            url: src.url,
            sha256: digest,
            downloadedAt: new Date().toISOString(),
          },
          null,
          2
        )}\n`
      );
      log.appendLine(
        `Orchestrator model ready at ${dest} (${digest.slice(0, 12)}…)`
      );
      return { path: dest, source: "downloaded", modelId: entry.id };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.appendLine(`Download failed from ${src.url}: ${lastError.message}`);
    }
  }

  throw lastError ?? new Error(`Failed to download model ${entry.id}`);
};

export const readModelManifest = async (
  context: vscode.ExtensionContext
): Promise<OrchestratorModelConfig | undefined> => {
  try {
    const raw = await fs.readFile(manifestPath(context), "utf8");
    return JSON.parse(raw) as OrchestratorModelConfig;
  } catch {
    return undefined;
  }
};

/** Returns whether a model asset exists for the selected model id. */
export const hasModelAsset = async (
  context: vscode.ExtensionContext,
  selectedModelId: string,
  options: {
    modelPath: string;
    modelMirrorUrl: string;
    modelReleaseAsset: string;
  }
): Promise<boolean> =>
  (await resolveModelAsset(context, { ...options, selectedModelId })) !==
  undefined;
