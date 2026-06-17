import * as vscode from "vscode";
import type {
  EndpointCacheEntry,
  EndpointConfig,
  ModelCacheFile,
} from "../config/schema.ts";
import { getSettings } from "../config/store.ts";
import { getEndpointApiKey } from "../secrets/prompt.ts";
import {
  readModelCache,
  resolveModelCachePath,
  setEndpointCache,
  shouldRefetchEndpointCache,
  writeModelCache,
} from "./cache.ts";
import {
  discoveryTtlMinutes,
  isDiscoveryEnabled,
  resolveModelsUrl,
  shouldRefreshOnActivate,
} from "./urls.ts";
import { isDiscoveryUrlAllowed } from "./url-validation.ts";
import { parseModelsResponse } from "./parse-models-response.ts";

export interface DiscoveryResult {
  endpointId: string;
  ok: boolean;
  modelCount: number;
  message: string;
}

export const discoverEndpointModels = async (
  endpoint: EndpointConfig,
  apiKey: string | undefined,
  log?: vscode.OutputChannel
): Promise<EndpointCacheEntry | undefined> => {
  const sourceUrl = resolveModelsUrl(endpoint);
  if (!isDiscoveryUrlAllowed(sourceUrl)) {
    log?.appendLine(
      `[discover:${endpoint.id}] blocked URL (private or disallowed): ${sourceUrl}`
    );
    return undefined;
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  try {
    const res = await fetch(sourceUrl, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const errBody = (await res.text()).slice(0, 200);
      log?.appendLine(
        `[discover:${endpoint.id}] HTTP ${res.status} for ${sourceUrl}${errBody ? `: ${errBody}` : ""}`
      );
      return undefined;
    }
    const body: unknown = await res.json();
    const models = parseModelsResponse(body);
    log?.appendLine(
      `[discover:${endpoint.id}] ${models.length} model(s) from ${sourceUrl}`
    );
    return {
      fetchedAt: new Date().toISOString(),
      sourceUrl,
      models,
    };
  } catch (err) {
    log?.appendLine(`[discover:${endpoint.id}] ${String(err)}`);
    return undefined;
  }
};

export { shouldRefetchEndpointCache } from "./cache-store.ts";

export const refreshModelCache = async (
  context: vscode.ExtensionContext,
  log?: vscode.OutputChannel,
  options?: { force?: boolean; secretRetries?: number }
): Promise<{ cache: ModelCacheFile; results: DiscoveryResult[] }> => {
  const settings = getSettings();
  const cachePath = resolveModelCachePath(context, settings.modelCachePath);
  let cache = await readModelCache(cachePath);
  const results: DiscoveryResult[] = [];

  await Promise.all(
    settings.endpoints.map(async (ep) => {
      if (!isDiscoveryEnabled(ep)) {
        results.push({
          endpointId: ep.id,
          ok: true,
          modelCount: ep.models?.length ?? 0,
          message: "discovery disabled",
        });
        return;
      }
      const ttl = discoveryTtlMinutes(ep);
      const existing = cache.endpoints[ep.id];
      if (!shouldRefetchEndpointCache(existing, ttl, options)) {
        results.push({
          endpointId: ep.id,
          ok: true,
          modelCount: existing!.models.length,
          message: "cache fresh",
        });
        return;
      }
      const apiKey = await getEndpointApiKey(context, ep, {
        retries: options?.secretRetries ?? 1,
      });
      const entry = await discoverEndpointModels(ep, apiKey, log);
      if (entry) {
        cache = setEndpointCache(cache, ep.id, entry);
        results.push({
          endpointId: ep.id,
          ok: true,
          modelCount: entry.models.length,
          message: "discovered",
        });
      } else if (existing) {
        results.push({
          endpointId: ep.id,
          ok: false,
          modelCount: existing.models.length,
          message: "fetch failed; kept stale cache",
        });
      } else {
        results.push({
          endpointId: ep.id,
          ok: false,
          modelCount: 0,
          message: "fetch failed; no cache",
        });
      }
    })
  );

  await writeModelCache(cachePath, cache);
  return { cache, results };
};

export const refreshModelCacheIfNeeded = async (
  context: vscode.ExtensionContext,
  log?: vscode.OutputChannel,
  options?: { secretRetries?: number }
): Promise<ModelCacheFile> => {
  const settings = getSettings();
  const cachePath = resolveModelCachePath(context, settings.modelCachePath);
  const cache = await readModelCache(cachePath);
  const needsRefresh = settings.endpoints.some((ep) => {
    if (!isDiscoveryEnabled(ep) || !shouldRefreshOnActivate(ep)) {
      return false;
    }
    return shouldRefetchEndpointCache(
      cache.endpoints[ep.id],
      discoveryTtlMinutes(ep)
    );
  });
  if (needsRefresh) {
    const { cache: updated } = await refreshModelCache(context, log, {
      secretRetries: options?.secretRetries ?? 5,
    });
    return updated;
  }
  return cache;
};
