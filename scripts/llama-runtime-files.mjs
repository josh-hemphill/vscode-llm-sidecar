/** Returns the llama-server executable basename for a platform id. */
export const llamaServerExeNameForPlatform = (platform = "") => {
  const os = platform.split("-")[0] ?? process.platform;
  return os === "win32" ? "llama-server.exe" : "llama-server";
};

/** True when a filename is a shared library (not an executable). */
export const isSharedLibraryFile = (name) => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".dll")) {
    return true;
  }
  if (lower.endsWith(".dylib")) {
    return true;
  }
  if (lower.endsWith(".so") || lower.includes(".so.")) {
    return true;
  }
  return false;
};

/** True when a filename is the llama-server executable for the platform. */
export const isLlamaServerExecutable = (name, platform = "") =>
  name === llamaServerExeNameForPlatform(platform);

/**
 * Keep llama-server plus all shared libs; drop other executables from archives.
 * @param {string} name
 * @param {string} [platform] e.g. win32-x64, linux-x64
 */
export const keepLlamaRuntimeFile = (name, platform = "") => {
  if (isLlamaServerExecutable(name, platform)) {
    return true;
  }
  if (isSharedLibraryFile(name)) {
    return true;
  }
  return false;
};

/** True when a shared lib name looks like ggml (runtime health check). */
export const isGgmlSharedLibrary = (name) => {
  const lower = name.toLowerCase();
  return lower.includes("ggml") && isSharedLibraryFile(name);
};
