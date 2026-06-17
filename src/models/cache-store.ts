import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MODEL_CACHE_VERSION } from "../config/schema.ts";
import type {
  EndpointCacheEntry,
  ModelCacheFile,
} from "../config/schema.ts";

export const readModelCache = async (
  cachePath: string
): Promise<ModelCacheFile> => {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as ModelCacheFile;
    if (parsed.version !== MODEL_CACHE_VERSION || !parsed.endpoints) {
      return emptyCache();
    }
    return parsed;
  } catch {
    return emptyCache();
  }
};

export const writeModelCache = async (
  cachePath: string,
  cache: ModelCacheFile
): Promise<void> => {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.rename(tmp, cachePath);
};

export const emptyCache = (): ModelCacheFile => ({
  version: MODEL_CACHE_VERSION,
  updatedAt: new Date().toISOString(),
  endpoints: {},
});

export const isCacheEntryStale = (
  entry: EndpointCacheEntry | undefined,
  ttlMinutes: number
): boolean => {
  if (!entry?.fetchedAt) {
    return true;
  }
  const fetched = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetched)) {
    return true;
  }
  const ageMs = Date.now() - fetched;
  return ageMs > ttlMinutes * 60 * 1000;
};

/** Whether discovery should run again (missing, stale, empty catalog, or forced). */
export const shouldRefetchEndpointCache = (
  existing: EndpointCacheEntry | undefined,
  ttlMinutes: number,
  options?: { force?: boolean }
): boolean => {
  if (options?.force) {
    return true;
  }
  if (!existing || existing.models.length === 0) {
    return true;
  }
  return isCacheEntryStale(existing, ttlMinutes);
};

export const getEndpointCache = (
  cache: ModelCacheFile,
  endpointId: string
): EndpointCacheEntry | undefined => cache.endpoints[endpointId];

export const setEndpointCache = (
  cache: ModelCacheFile,
  endpointId: string,
  entry: EndpointCacheEntry
): ModelCacheFile => ({
  ...cache,
  updatedAt: new Date().toISOString(),
  endpoints: { ...cache.endpoints, [endpointId]: entry },
});
