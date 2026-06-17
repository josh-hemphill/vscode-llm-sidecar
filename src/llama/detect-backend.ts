import { execSync } from "node:child_process";
import type { LlamaServerVariant } from "../config/schema.ts";

/** Detects whether nvidia-smi is available. */
export const hasNvidiaGpu = (): boolean => {
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Auto-detects preferred llama-server variant for this machine. */
export const detectLlamaVariant = (): Exclude<LlamaServerVariant, "auto"> => {
  if (process.platform === "darwin") {
    return "metal";
  }
  if (
    (process.platform === "win32" || process.platform === "linux") &&
    hasNvidiaGpu()
  ) {
    return "cuda13";
  }
  return "cpu";
};

/** Resolves variant setting, expanding auto to detected backend. */
export const resolveLlamaVariantSetting = (
  setting: LlamaServerVariant
): Exclude<LlamaServerVariant, "auto"> =>
  setting === "auto" ? detectLlamaVariant() : setting;
