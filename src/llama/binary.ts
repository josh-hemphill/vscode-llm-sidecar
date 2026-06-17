import { existsSync } from "node:fs";
import * as path from "node:path";
import type { LlmSidecarSettings } from "../config/schema.ts";

const llamaExecutableName = (): string =>
  process.platform === "win32" ? "llama-server.exe" : "llama-server";

export const llamaPlatformArchDir = (): string =>
  `${process.platform}-${process.arch}`;

export const llamaServerCandidates = (
  settings: LlmSidecarSettings,
  extensionPath: string
): string[] => {
  const configured = settings.orchestrator.llamaServerBinaryPath.trim();
  if (configured) {
    return [configured];
  }
  const exe = llamaExecutableName();
  const platformArch = llamaPlatformArchDir();
  const installDir = settings.orchestrator.llamaServerInstallDir.trim();
  const candidates = [
    path.join(extensionPath, "bin", platformArch, exe),
    path.join(extensionPath, "bin", exe),
  ];
  if (installDir) {
    candidates.unshift(path.join(installDir, exe));
  }
  return candidates;
};

export const resolveLlamaServerBinary = (
  settings: LlmSidecarSettings,
  extensionPath: string
): string | undefined => {
  for (const candidate of llamaServerCandidates(settings, extensionPath)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};
