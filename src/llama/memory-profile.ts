import type {
  FitDeviceMemoryMode,
  FlashAttentionMode,
  KvCacheType,
  LlamaServerVariant,
} from "../config/schema.ts";

export interface ResolvedMemoryProfile {
  ctxSize: number;
  batchSize: number;
  ubatchSize: number;
  kvCacheType: Exclude<KvCacheType, "auto">;
  fitDeviceMemory: boolean;
  flashAttention: boolean;
  allowMlock: boolean;
}

const GIB = 1024 * 1024 * 1024;

const gpuBackedVariant = (variant: Exclude<LlamaServerVariant, "auto">): boolean =>
  variant === "metal" ||
  variant === "cuda12" ||
  variant === "cuda13" ||
  variant === "vulkan";

/** Resolves RAM-tier defaults for llama-server launch (unified-memory laptops). */
export const resolveMemoryProfile = (
  totalMemBytes: number,
  variant: Exclude<LlamaServerVariant, "auto">
): ResolvedMemoryProfile => {
  const memGb = totalMemBytes / GIB;

  if (memGb <= 8) {
    return {
      ctxSize: 4096,
      batchSize: 256,
      ubatchSize: 128,
      kvCacheType: "q4_0",
      fitDeviceMemory: true,
      flashAttention: gpuBackedVariant(variant),
      allowMlock: false,
    };
  }
  if (memGb <= 16) {
    return {
      ctxSize: 6144,
      batchSize: 512,
      ubatchSize: 256,
      kvCacheType: "q8_0",
      fitDeviceMemory: true,
      flashAttention: gpuBackedVariant(variant),
      allowMlock: false,
    };
  }
  if (memGb <= 24) {
    return {
      ctxSize: 8192,
      batchSize: 0,
      ubatchSize: 0,
      kvCacheType: "q8_0",
      fitDeviceMemory: false,
      flashAttention: gpuBackedVariant(variant),
      allowMlock: true,
    };
  }
  return {
    ctxSize: 8192,
    batchSize: 0,
    ubatchSize: 0,
    kvCacheType: "f16",
    fitDeviceMemory: false,
    flashAttention: gpuBackedVariant(variant),
    allowMlock: true,
  };
};

/** Resolves flash attention from auto/on/off and the RAM profile. */
export const resolveFlashAttention = (
  mode: FlashAttentionMode,
  profileFlash: boolean
): boolean => {
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return profileFlash;
};

/** Resolves fit-device-memory from auto/on/off and the RAM profile. */
export const resolveFitDeviceMemory = (
  mode: FitDeviceMemoryMode,
  profileFit: boolean
): boolean => {
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return profileFit;
};

/** Resolves KV cache type from auto or an explicit quant. */
export const resolveKvCacheType = (
  mode: KvCacheType,
  profileKv: Exclude<KvCacheType, "auto">
): Exclude<KvCacheType, "auto"> => (mode === "auto" ? profileKv : mode);
