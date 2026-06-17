import * as path from "node:path";
import type * as vscode from "vscode";

export {
  emptyCache,
  getEndpointCache,
  isCacheEntryStale,
  readModelCache,
  setEndpointCache,
  shouldRefetchEndpointCache,
  writeModelCache,
} from "./cache-store.ts";

export const resolveModelCachePath = (
  context: vscode.ExtensionContext,
  modelCachePathSetting = ""
): string => {
  const custom = modelCachePathSetting.trim();
  if (custom) {
    return custom;
  }
  return path.join(context.globalStorageUri.fsPath, "models-cache.json");
};
