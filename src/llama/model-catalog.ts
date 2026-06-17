import {
  DEFAULT_MODEL_ID,
  ORCHESTRATOR_MODEL_CATALOG,
  type OrchestratorCatalogEntry,
} from "../config/schema.ts";
import { loadRuntimeManifest } from "../config/runtime-manifest.ts";

/** Returns catalog entries for QuickPick and validation. */
export const listOrchestratorModels = (
  extensionPath?: string
): OrchestratorCatalogEntry[] => {
  if (extensionPath) {
    try {
      return loadRuntimeManifest(extensionPath).models;
    } catch {
      return ORCHESTRATOR_MODEL_CATALOG;
    }
  }
  return ORCHESTRATOR_MODEL_CATALOG;
};

/** Resolves catalog entry by id, falling back to default. */
export const resolveCatalogEntry = (
  modelId: string,
  extensionPath?: string
): OrchestratorCatalogEntry => {
  const catalog = listOrchestratorModels(extensionPath);
  return (
    catalog.find((m) => m.id === modelId) ??
    catalog.find((m) => m.isDefault) ??
    catalog[0]!
  );
};

/** Returns globalStorage cache path for a model filename. */
export const modelCacheFilePath = (
  globalStoragePath: string,
  modelId = DEFAULT_MODEL_ID,
  extensionPath?: string
): string => {
  const entry = resolveCatalogEntry(modelId, extensionPath);
  return `${globalStoragePath}/models/${entry.filename}`;
};

/** Returns dev cache path under extension .assets/models. */
export const devModelFilePath = (
  extensionPath: string,
  modelId = DEFAULT_MODEL_ID
): string => {
  const entry = resolveCatalogEntry(modelId, extensionPath);
  return `${extensionPath}/.assets/models/${entry.filename}`;
};

/** Resolves download URLs: verified mirror first, then manifest sources. */
export const resolveModelSources = (
  entry: OrchestratorCatalogEntry,
  mirrorUrl = "",
  mirrorSha256 = ""
): Array<{ kind: string; url: string; sha256: string }> => {
  const sources: Array<{ kind: string; url: string; sha256: string }> = [];
  const mirror = mirrorUrl.trim();
  const mirrorHash = mirrorSha256.trim();
  if (mirror && mirrorHash) {
    sources.push({ kind: "mirror", url: mirror, sha256: mirrorHash });
  }
  for (const src of entry.sources) {
    const sha256 = src.sha256?.trim() ?? "";
    if (!sha256) {
      continue;
    }
    sources.push({
      kind: src.kind,
      url: src.url,
      sha256,
    });
  }
  return sources;
};

export const formatModelSizeGb = (sizeBytes: number): string =>
  `${(sizeBytes / 1_000_000_000).toFixed(1)} GB`;
