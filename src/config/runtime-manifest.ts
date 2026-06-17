import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorCatalogEntry } from "./schema.ts";

export interface RuntimeManifestLlamaAsset {
  url: string;
  archiveType: "zip" | "tar.gz";
  binaryPathInsideArchive: string;
  sha256?: string;
}

export interface RuntimeManifest {
  version: number;
  llamaServer: {
    releaseTag: string;
    variants: string[];
    platforms: Record<
      string,
      Record<string, RuntimeManifestLlamaAsset>
    >;
  };
  models: OrchestratorCatalogEntry[];
}

/** Loads the bundled runtime assets manifest from the extension directory. */
export const loadRuntimeManifest = (
  extensionPath: string
): RuntimeManifest => {
  const manifestPath = join(extensionPath, "assets", "runtime-manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
};
