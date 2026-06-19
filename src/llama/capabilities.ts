import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

export interface LlamaServerCapabilities {
  fit: boolean;
  nglAuto: boolean;
  cacheTypeK: boolean;
  cacheTypeV: boolean;
  flashAttn: boolean;
  flashAttnTakesValue: boolean;
  batchSize: boolean;
  ubatchSize: boolean;
  mlock: boolean;
}

const emptyCaps = (): LlamaServerCapabilities => ({
  fit: false,
  nglAuto: false,
  cacheTypeK: false,
  cacheTypeV: false,
  flashAttn: false,
  flashAttnTakesValue: false,
  batchSize: false,
  ubatchSize: false,
  mlock: false,
});

const cache = new Map<string, LlamaServerCapabilities>();

/** Parses llama-server --help output into supported launch flags. */
export const parseLlamaServerHelp = (helpText: string): LlamaServerCapabilities => {
  const caps = emptyCaps();
  const text = helpText.toLowerCase();

  caps.fit = /--fit\b/.test(text) || /\s-fit\b/.test(text);
  caps.nglAuto =
    /n-gpu-layers.*\bauto\b/.test(text) ||
    /gpu-layers.*\bauto\b/.test(text) ||
    /-ngl.*\bauto\b/.test(text);
  caps.cacheTypeK = /--cache-type-k\b/.test(text);
  caps.cacheTypeV = /--cache-type-v\b/.test(text);
  caps.flashAttn = /--flash-attn\b/.test(text) || /\s-fa\b/.test(text);
  caps.flashAttnTakesValue =
    /--flash-attn\s+\[?on\|off\]?/i.test(helpText) ||
    /--flash-attn.*\bon\|off\b/i.test(helpText);
  caps.batchSize = /\s-b\b/.test(text) || /--batch-size\b/.test(text);
  caps.ubatchSize =
    /--ubatch-size\b/.test(text) || /\s-ub\b/.test(text);
  caps.mlock = /--mlock\b/.test(text);

  return caps;
};

/** Returns cached llama-server capabilities from --help (fail-open on error). */
export const detectLlamaServerCapabilities = (
  binaryPath: string
): LlamaServerCapabilities => {
  try {
    const mtime = statSync(binaryPath).mtimeMs;
    const key = `${binaryPath}:${mtime}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const helpText = execFileSync(binaryPath, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const caps = parseLlamaServerHelp(helpText);
    cache.set(key, caps);
    return caps;
  } catch {
    return emptyCaps();
  }
};
