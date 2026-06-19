import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import {
  BUILTIN_PROFILES,
  DEFAULT_ORCHESTRATOR,
  DEFAULT_SYNC_TARGETS,
  type LlmSidecarSettings,
  type EndpointConfig,
  type ModelCacheFile,
  type NamedProfile,
  type OverrideModelConfig,
  type ProxyConfigPayload,
  type ResolvedModel,
  type WorkspaceContextPayload,
} from "./schema.ts";
import {
  readModelCache,
  resolveModelCachePath,
} from "../models/cache.ts";
import { resolveEndpointSecretId } from "../secrets/keys.ts";
import { endpointsWithMergedModels } from "../models/merge.ts";
import { normalizeUpstreamChatUrl } from "../models/urls.ts";

const SECTION = "llmSidecar";

export const getSettings = (): LlmSidecarSettings => {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const orchestratorCfg = cfg.get<Partial<LlmSidecarSettings["orchestrator"]>>(
    "orchestrator",
    {}
  );
  return {
    proxyPort: cfg.get<number>("proxyPort", 3848),
    autoStartProxy: cfg.get<boolean>("autoStartProxy", true),
    autoStartLlama: cfg.get<boolean>("autoStartLlama", true),
    autoSyncOnActivate: cfg.get<boolean>("autoSyncOnActivate", true),
    proxyBinaryPath: cfg.get<string>("proxyBinaryPath", ""),
    profilesPath: cfg.get<string>("profilesPath", ""),
    modelCachePath: cfg.get<string>("modelCachePath", ""),
    copilotByokSecretId: cfg.get<string>("copilotByokSecretId", "llmSidecar"),
    enforceHumanInTheLoop: cfg.get<boolean>("enforceHumanInTheLoop", true),
    profiles: cfg.get<Record<string, NamedProfile>>("profiles", {}),
    endpoints: cfg.get<EndpointConfig[]>("endpoints", []),
    modelOverrides: cfg.get<Record<string, OverrideModelConfig>>(
      "modelOverrides",
      {}
    ),
    syncTargets: cfg.get("syncTargets", DEFAULT_SYNC_TARGETS),
    inlineCompletion: cfg.get("inlineCompletion", { enabled: false }),
    orchestrator: { ...DEFAULT_ORCHESTRATOR, ...orchestratorCfg },
  };
};

export const loadMergedProfiles = async (
  settings: LlmSidecarSettings
): Promise<Record<string, NamedProfile>> => {
  const merged: Record<string, NamedProfile> = {
    ...BUILTIN_PROFILES,
    ...settings.profiles,
  };
  if (!settings.profilesPath.trim()) {
    return merged;
  }
  try {
    const raw = await fs.readFile(settings.profilesPath, "utf8");
    const fromFile = JSON.parse(raw) as Record<string, NamedProfile>;
    return { ...merged, ...fromFile };
  } catch (err) {
    console.warn(`LLM Sidecar: failed to load profiles from ${settings.profilesPath}: ${String(err)}`);
    return merged;
  }
};

export const loadModelCacheForContext = async (
  context: vscode.ExtensionContext
): Promise<ModelCacheFile> => {
  const settings = getSettings();
  const cachePath = resolveModelCachePath(context, settings.modelCachePath);
  return readModelCache(cachePath);
};

export const resolveModelsForContext = async (
  context: vscode.ExtensionContext
): Promise<ResolvedModel[]> => {
  const settings = getSettings();
  const profiles = await loadMergedProfiles(settings);
  const cache = await loadModelCacheForContext(context);
  const { mergeResolvedModels } = await import("../models/merge.ts");
  return mergeResolvedModels(settings, cache, profiles);
};

export const buildProxyPayload = async (
  context: vscode.ExtensionContext,
  settings: LlmSidecarSettings,
  cache?: ModelCacheFile,
  workspace?: WorkspaceContextPayload
): Promise<ProxyConfigPayload> => {
  const profiles = await loadMergedProfiles(settings);
  const modelCache = cache ?? (await loadModelCacheForContext(context));
  const mergedEndpoints = endpointsWithMergedModels(
    settings,
    modelCache,
    profiles
  );
  const endpoints = await Promise.all(
    mergedEndpoints.map(async (ep) => {
      const raw = await context.secrets.get(resolveEndpointSecretId(ep));
      const apiKey = raw?.trim() || undefined;
      const upstreamUrl = normalizeUpstreamChatUrl(ep.upstreamUrl);
      return { ...ep, upstreamUrl, apiKey };
    })
  );
  const ws = workspace ?? {
    roots: [],
    openFiles: [],
    recentFiles: [],
    diagnostics: [],
  };
  const {
    llamaServerBinaryPath: _b,
    modelPath: _p,
    modelMirrorUrl: _m,
    modelReleaseAsset: _r,
    gpuLayers: _g,
    ctxSize: _c,
    kvCacheType: _kv,
    flashAttention: _fa,
    fitDeviceMemory: _fit,
    fitTargetMib: _fitTarget,
    batchSize: _batch,
    ubatchSize: _ubatch,
    mlock: _mlock,
    llamaStartMode: _startMode,
    llamaIdleTimeoutSec: _idle,
    llamaPort,
    ...orchestratorForProxy
  } = settings.orchestrator;
  return {
    profiles,
    endpoints,
    orchestrator: {
      ...orchestratorForProxy,
      llamaPort,
      llamaBaseUrl: settings.orchestrator.llamaBaseUrl.replace(/:\d+$/, `:${llamaPort}`),
      workspace: ws,
    },
  };
};

export {
  proxyBinaryCandidates,
  proxyPlatformArchDir,
  resolveProxyBinary,
} from "./proxy-binary.ts";
