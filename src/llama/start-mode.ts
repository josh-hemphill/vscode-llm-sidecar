import type { LlamaStartMode } from "../config/schema.ts";

/** Resolves effective llama start mode (autoStartLlama=false -> manual). */
export const resolveLlamaStartMode = (
  autoStartLlama: boolean,
  mode: LlamaStartMode
): LlamaStartMode => {
  if (!autoStartLlama) {
    return "manual";
  }
  return mode;
};
