import { existsSync } from "node:fs";
import * as path from "node:path";
import type { LlmSidecarSettings } from "./schema.ts";

const proxyExecutableName = (): string =>
  process.platform === "win32" ? "sidecar-proxy.exe" : "sidecar-proxy";

/** Platform-arch subdirectory for packaged VSIX binaries (e.g. win32-x64). */
export const proxyPlatformArchDir = (): string =>
  `${process.platform}-${process.arch}`;

export const proxyBinaryCandidates = (
  settings: LlmSidecarSettings,
  extensionPath: string
): string[] => {
  if (settings.proxyBinaryPath.trim()) {
    return [settings.proxyBinaryPath.trim()];
  }
  const exe = proxyExecutableName();
  const platformArch = proxyPlatformArchDir();
  return [
    path.join(extensionPath, "bin", platformArch, exe),
    path.join(extensionPath, "bin", exe),
    path.join(extensionPath, "target", "release", exe),
    path.join(extensionPath, "target", "debug", exe),
  ];
};

export const resolveProxyBinary = (
  settings: LlmSidecarSettings,
  extensionPath: string
): string | undefined => {
  for (const c of proxyBinaryCandidates(settings, extensionPath)) {
    if (existsSync(c)) {
      return c;
    }
  }
  return undefined;
};
