import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = join(root, "assets", "runtime-manifest.json");

export const platformArchDir = () => `${process.platform}-${process.arch}`;

export const llamaServerExeName = () =>
  process.platform === "win32" ? "llama-server.exe" : "llama-server";

/** Returns true when the installed llama-server bundle can run. */
export const isLlamaRuntimeBundleComplete = (destDir) => {
  const exePath = join(destDir, llamaServerExeName());
  if (!existsSync(exePath)) {
    return false;
  }
  if (process.platform === "win32") {
    return existsSync(join(destDir, "llama-server-impl.dll"));
  }
  return true;
};

/** Copies all files from an extracted llama.cpp archive into the install dir. */
export const copyLlamaRuntimeBundle = (extractDir, destDir) => {
  mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(extractDir)) {
    const src = join(extractDir, name);
    if (!statSync(src).isFile()) {
      continue;
    }
    copyFileSync(src, join(destDir, name));
    copied += 1;
  }
  return copied;
};

/** Reads and parses the runtime assets manifest. */
export const loadManifest = (manifestPath = defaultManifestPath) => {
  const raw = readFileSync(manifestPath, "utf8");
  return JSON.parse(raw);
};

/** Returns model entry by id or default model. */
export const getModelEntry = (manifest, modelId) => {
  const models = manifest.models ?? [];
  if (modelId === "default") {
    return models.find((m) => m.isDefault) ?? models[0];
  }
  return models.find((m) => m.id === modelId);
};

/** Resolves download URLs: verified mirror first, then manifest sources with sha256. */
export const resolveModelSources = (modelEntry, mirrorUrl = "", mirrorSha256 = "") => {
  const sources = [];
  const mirror = mirrorUrl.trim();
  const mirrorHash = mirrorSha256.trim();
  if (mirror && mirrorHash) {
    sources.push({ kind: "mirror", url: mirror, sha256: mirrorHash });
  }
  for (const src of modelEntry?.sources ?? []) {
    const sha256 = src.sha256?.trim() ?? "";
    if (!sha256) {
      continue;
    }
    sources.push({ ...src, sha256 });
  }
  return sources;
};

/** Computes SHA-256 hex digest for a file. */
export const sha256File = async (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });

/** Downloads a URL to dest with optional sha256 verification. */
export const downloadFile = async (
  url,
  dest,
  { expectedSha256 = "", onProgress, headers = {} } = {}
) => {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  const mergedHeaders = { ...headers };
  if (process.env.HF_TOKEN?.trim()) {
    mergedHeaders.Authorization = `Bearer ${process.env.HF_TOKEN.trim()}`;
  }

  const res = await fetch(url, { headers: mergedHeaders });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }

  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  const out = createWriteStream(tmp);

  for await (const chunk of Readable.fromWeb(res.body)) {
    out.write(chunk);
    received += chunk.length;
    if (total > 0 && onProgress) {
      onProgress(Math.round((received / total) * 100));
    }
  }
  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });

  if (expectedSha256) {
    const digest = await sha256File(tmp);
    if (digest !== expectedSha256.toLowerCase()) {
      rmSync(tmp, { force: true });
      throw new Error(
        `SHA-256 mismatch for ${url} (expected ${expectedSha256}, got ${digest})`
      );
    }
  } else {
    rmSync(tmp, { force: true });
    throw new Error(`Refusing download without expected SHA-256: ${url}`);
  }

  renameSync(tmp, dest);
  return dest;
};

/** Extracts zip or tar.gz archive into destDir. */
export const extractArchive = (archivePath, destDir) => {
  mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      const ps = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "inherit" });
      return;
    }
    execSync(`unzip -o -q "${archivePath}" -d "${destDir}"`, {
      stdio: "inherit",
    });
    return;
  }
  execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: "inherit" });
};

/** Detects whether nvidia-smi is available. */
export const hasNvidiaGpu = () => {
  try {
    execSync("nvidia-smi", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Auto-detects preferred llama-server variant for this machine. */
export const detectLlamaVariant = () => {
  if (process.platform === "darwin") {
    return "metal";
  }
  if (process.platform === "win32" || process.platform === "linux") {
    if (hasNvidiaGpu()) {
      return "cuda13";
    }
    if (process.platform === "win32") {
      return "cpu";
    }
  }
  return "cpu";
};

/** Resolves llama-server asset for platform and variant with fallbacks. */
export const resolveLlamaServerAsset = (
  manifest,
  { variant = "cpu", platformArch = platformArchDir() } = {}
) => {
  const platforms = manifest.llamaServer?.platforms ?? {};
  const platform = platforms[platformArch];
  if (!platform) {
    throw new Error(`No llama-server platform entry for ${platformArch}`);
  }

  const chain =
    variant === "auto"
      ? [detectLlamaVariant(), "cuda12", "cuda13", "vulkan", "cpu", "metal"]
      : [variant, "cpu", "metal"];

  for (const v of chain) {
    const entry = platform[v];
    if (entry?.url) {
      return { ...entry, variant: v, platformArch };
    }
  }
  throw new Error(
    `No llama-server variant available for ${platformArch} (tried ${chain.join(", ")})`
  );
};

/** Finds llama-server binary inside extracted tree. */
export const findExtractedBinary = (extractDir, relativePath) => {
  const direct = join(extractDir, relativePath);
  if (existsSync(direct)) {
    return direct;
  }
  const walk = (dir, depth = 0) => {
    if (depth > 6) {
      return undefined;
    }
    for (const name of readdirSafe(dir)) {
      const full = join(dir, name);
      if (name === relativePath || name === llamaServerExeName()) {
        return full;
      }
      if (statSafe(full)?.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(extractDir);
};

const readdirSafe = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const statSafe = (p) => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};

/** Downloads and installs llama-server into destDir (bin/platform-arch). */
export const installLlamaServer = async (
  manifest,
  destDir,
  { variant = "auto", force = false, onProgress } = {}
) => {
  const asset = resolveLlamaServerAsset(manifest, { variant });
  const exeDest = join(destDir, llamaServerExeName());
  if (
    isLlamaRuntimeBundleComplete(destDir) &&
    !force
  ) {
    return { path: exeDest, variant: asset.variant, skipped: true };
  }

  const cacheDir = join(root, ".assets", "cache", "llama-server");
  mkdirSync(cacheDir, { recursive: true });
  const archiveName = asset.url.split("/").pop() ?? "llama.zip";
  const archivePath = join(cacheDir, archiveName);
  const extractDir = join(cacheDir, `${asset.platformArch}-${asset.variant}`);

  if (!existsSync(archivePath)) {
    await downloadFile(asset.url, archivePath, { onProgress });
  }

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  extractArchive(archivePath, extractDir);

  const found =
    findExtractedBinary(extractDir, asset.binaryPathInsideArchive) ??
    findExtractedBinary(extractDir, llamaServerExeName());
  if (!found) {
    throw new Error(`llama-server binary not found inside ${archivePath}`);
  }

  mkdirSync(destDir, { recursive: true });
  const copied = copyLlamaRuntimeBundle(extractDir, destDir);
  if (process.platform !== "win32") {
    execSync(`chmod +x "${exeDest}"`);
  }

  return { path: exeDest, variant: asset.variant, skipped: false, copied };
};

/** Downloads a model GGUF to dest path. */
export const installModel = async (
  manifest,
  modelId,
  destPath,
  { mirrorUrl = "", force = false, onProgress } = {}
) => {
  const entry = getModelEntry(manifest, modelId);
  if (!entry) {
    throw new Error(`Unknown model id: ${modelId}`);
  }
  if (existsSync(destPath) && !force) {
    return { path: destPath, modelId: entry.id, skipped: true };
  }

  const sources = resolveModelSources(entry, mirrorUrl);
  let lastError;
  for (const src of sources) {
    try {
      await downloadFile(src.url, destPath, {
        expectedSha256: src.sha256 || entry.sources?.[0]?.sha256 || "",
        onProgress,
      });
      return { path: destPath, modelId: entry.id, skipped: false, source: src.kind };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error(`Failed to download model ${modelId}`);
};

/** HEAD-checks a remote URL. */
export const checkRemoteUrl = async (url) => {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
};
