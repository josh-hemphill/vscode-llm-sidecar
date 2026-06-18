import { existsSync, readdirSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Returns the platform-specific llama-server executable filename. */
export const llamaServerBinaryName = (): string =>
  process.platform === "win32" ? "llama-server.exe" : "llama-server";

/** Returns true when the installed llama-server bundle can run. */
export const isLlamaRuntimeBundleComplete = (installDir: string): boolean => {
  const exePath = path.join(installDir, llamaServerBinaryName());
  if (!existsSync(exePath)) {
    return false;
  }
  if (process.platform === "win32") {
    return existsSync(path.join(installDir, "llama-server-impl.dll"));
  }
  return true;
};

/** Resolves the directory containing llama-server after archive extraction. */
export const resolveLlamaBundleRoot = (extractDir: string): string => {
  const entries = readdirSync(extractDir);
  let fileCount = 0;
  const subdirs: string[] = [];
  for (const name of entries) {
    const full = path.join(extractDir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      subdirs.push(name);
    } else if (st.isFile()) {
      fileCount += 1;
    }
  }
  if (fileCount === 0 && subdirs.length === 1) {
    return path.join(extractDir, subdirs[0]!);
  }
  return extractDir;
};

const copyTree = async (srcDir: string, destDir: string): Promise<number> => {
  let copied = 0;
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(dest, { recursive: true });
      copied += await copyTree(src, dest);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await fs.copyFile(src, dest);
    copied += 1;
  }
  return copied;
};

/** Copies all files from an extracted llama.cpp archive into the install dir. */
export const copyLlamaRuntimeBundle = async (
  extractDir: string,
  installDir: string
): Promise<number> => {
  const bundleRoot = resolveLlamaBundleRoot(extractDir);
  await fs.mkdir(installDir, { recursive: true });
  return copyTree(bundleRoot, installDir);
};

export const windowsDllMissingExitCode = 3221225781;

/** Describes common llama-server startup failures on Windows. */
export const describeLlamaExitCode = (code: number | null): string | undefined => {
  if (code === windowsDllMissingExitCode || code === -1073741515) {
    return (
      "llama-server failed to load required DLLs. Re-run “Download Llama Server” " +
      "(or fetch:llama-server --force). If using a CUDA build, install the matching " +
      "NVIDIA/CUDA runtime or set llmSidecar.orchestrator.llamaServerVariant to cpu."
    );
  }
  return undefined;
};
