import type { ConfigurationChangeEvent } from "vscode";
import type { OrchestratorConfig } from "../config/schema.ts";
import type { LlamaServerCapabilities } from "./capabilities.ts";
import {
  resolveFitDeviceMemory,
  resolveFlashAttention,
  resolveKvCacheType,
  type ResolvedMemoryProfile,
} from "./memory-profile.ts";

export interface BuildLlamaServerArgsInput {
  settings: OrchestratorConfig;
  profile: ResolvedMemoryProfile;
  caps: LlamaServerCapabilities;
  modelPath: string;
  port: number;
  slotSavePath: string;
}

export interface ResolvedLlamaLaunch {
  args: string[];
  ctxSize: number;
  kvCacheType: string;
  fitEnabled: boolean;
  flashAttention: boolean;
}

/** Builds llama-server argv from settings, RAM profile, and binary capabilities. */
export const buildLlamaServerArgs = (
  input: BuildLlamaServerArgsInput
): ResolvedLlamaLaunch => {
  const { settings, profile, caps, modelPath, port, slotSavePath } = input;

  const ctxSize =
    settings.ctxSize > 0 ? settings.ctxSize : profile.ctxSize;
  const kvCacheType = resolveKvCacheType(
    settings.kvCacheType,
    profile.kvCacheType
  );
  const fitEnabled = resolveFitDeviceMemory(
    settings.fitDeviceMemory,
    profile.fitDeviceMemory
  );
  const flashAttention = resolveFlashAttention(
    settings.flashAttention,
    profile.flashAttention
  );
  const batchSize =
    settings.batchSize > 0 ? settings.batchSize : profile.batchSize;
  const ubatchSize =
    settings.ubatchSize > 0 ? settings.ubatchSize : profile.ubatchSize;
  const mlock = settings.mlock && profile.allowMlock;

  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-m",
    modelPath,
    "--ctx-size",
    String(ctxSize),
    "--parallel",
    "1",
    "--cont-batching",
    "--slot-save-path",
    slotSavePath,
  ];

  if (fitEnabled && caps.fit && caps.nglAuto && settings.gpuLayers !== 0) {
    args.push("-ngl", "auto", "--fit", "on", "--fit-target", String(settings.fitTargetMib));
  } else if (settings.gpuLayers !== 0) {
    args.push("-ngl", String(settings.gpuLayers));
  }

  if (kvCacheType !== "f16") {
    if (caps.cacheTypeK) {
      args.push("--cache-type-k", kvCacheType);
    }
    if (caps.cacheTypeV) {
      args.push("--cache-type-v", kvCacheType);
    }
  }

  if (flashAttention && caps.flashAttn) {
    if (caps.flashAttnTakesValue) {
      args.push("--flash-attn", "on");
    } else {
      args.push("--flash-attn");
    }
  }

  if (batchSize > 0 && caps.batchSize) {
    args.push("-b", String(batchSize));
  }
  if (ubatchSize > 0 && caps.ubatchSize) {
    args.push("-ub", String(ubatchSize));
  }
  if (mlock && caps.mlock) {
    args.push("--mlock");
  }

  return {
    args,
    ctxSize,
    kvCacheType,
    fitEnabled,
    flashAttention,
  };
};

/** Settings keys that require restarting llama-server when changed. */
export const LLAMA_LAUNCH_SETTING_KEYS = [
  "llmSidecar.orchestrator.ctxSize",
  "llmSidecar.orchestrator.gpuLayers",
  "llmSidecar.orchestrator.kvCacheType",
  "llmSidecar.orchestrator.flashAttention",
  "llmSidecar.orchestrator.fitDeviceMemory",
  "llmSidecar.orchestrator.fitTargetMib",
  "llmSidecar.orchestrator.batchSize",
  "llmSidecar.orchestrator.ubatchSize",
  "llmSidecar.orchestrator.mlock",
  "llmSidecar.orchestrator.llamaPort",
  "llmSidecar.orchestrator.llamaServerVariant",
  "llmSidecar.orchestrator.llamaServerBinaryPath",
  "llmSidecar.orchestrator.selectedModelId",
  "llmSidecar.orchestrator.modelPath",
] as const;

/** True when a configuration change affects llama-server launch args. */
export const affectsLlamaLaunch = (e: ConfigurationChangeEvent): boolean =>
  LLAMA_LAUNCH_SETTING_KEYS.some((key) => e.affectsConfiguration(key));
