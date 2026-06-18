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

/** Resolves the directory containing llama-server after archive extraction. */
export const resolveLlamaBundleRoot = (extractDir) => {
  const entries = readdirSync(extractDir);
  let fileCount = 0;
  const subdirs = [];
  for (const name of entries) {
    const full = join(extractDir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      subdirs.push(name);
    } else if (st.isFile()) {
      fileCount += 1;
    }
  }
  if (fileCount === 0 && subdirs.length === 1) {
    return join(extractDir, subdirs[0]);
  }
  return extractDir;
};

const copyTreeSync = (srcDir, destDir) => {
  mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dest = join(destDir, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      copied += copyTreeSync(src, dest);
      continue;
    }
    if (!st.isFile()) {
      continue;
    }
    copyFileSync(src, dest);
    copied += 1;
  }
  return copied;
};

/** Copies all files from an extracted llama.cpp archive into the install dir. */
export const copyLlamaRuntimeBundle = (extractDir, destDir) => {
  const bundleRoot = resolveLlamaBundleRoot(extractDir);
  return copyTreeSync(bundleRoot, destDir);
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

/** Ensures a cached archive exists and matches the pinned sha256. */
const ensureVerifiedArchive = async (
  url,
  archivePath,
  expectedSha256,
  { onProgress, force = false } = {}
) => {
  const hash = expectedSha256?.trim().toLowerCase() ?? "";
  if (!hash) {
    throw new Error(`Manifest entry missing sha256: ${url}`);
  }
  if (!force && existsSync(archivePath)) {
    const digest = await sha256File(archivePath);
    if (digest === hash) {
      return;
    }
    rmSync(archivePath, { force: true });
  } else if (force && existsSync(archivePath)) {
    rmSync(archivePath, { force: true });
  }
  await downloadFile(url, archivePath, { onProgress, expectedSha256: hash });
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

  await ensureVerifiedArchive(asset.url, archivePath, asset.sha256, {
    onProgress,
    force,
  });

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
  if (!isLlamaRuntimeBundleComplete(destDir)) {
    throw new Error(
      `llama-server bundle incomplete after install (expected ${exeDest})`
    );
  }
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

/** Validates runtime manifest structure and pinned checksums (no network or local binaries). */
export const validateRuntimeManifest = (manifest) => {
  const errors = [];
  const sha256Re = /^[a-f0-9]{64}$/i;

  if (!manifest || typeof manifest !== "object") {
    return ["manifest must be an object"];
  }
  if (typeof manifest.version !== "number" || manifest.version < 1) {
    errors.push("manifest.version must be a positive integer");
  }

  const platforms = manifest.llamaServer?.platforms;
  if (!platforms || typeof platforms !== "object") {
    errors.push("llamaServer.platforms is required");
  } else {
    for (const [platformArch, variants] of Object.entries(platforms)) {
      if (!variants || typeof variants !== "object") {
        errors.push(`llamaServer.platforms.${platformArch} must be an object`);
        continue;
      }
      if (!variants.cpu?.url) {
        errors.push(`llamaServer.platforms.${platformArch}.cpu.url is required`);
      }
      for (const [variantName, entry] of Object.entries(variants)) {
        if (!entry?.url) {
          errors.push(
            `llamaServer.platforms.${platformArch}.${variantName} missing url`
          );
          continue;
        }
        const hash = entry.sha256?.trim() ?? "";
        if (!hash) {
          errors.push(
            `llamaServer.platforms.${platformArch}.${variantName} missing sha256`
          );
        } else if (!sha256Re.test(hash)) {
          errors.push(
            `llamaServer.platforms.${platformArch}.${variantName} invalid sha256`
          );
        }
      }
    }
  }

  const models = manifest.models;
  if (!Array.isArray(models) || models.length === 0) {
    errors.push("models must be a non-empty array");
  } else {
    for (const model of models) {
      const label = model.id ?? "(unknown model)";
      if (!model.id) {
        errors.push("model entry missing id");
      }
      if (!model.filename) {
        errors.push(`${label}: missing filename`);
      }
      if (!Array.isArray(model.sources) || model.sources.length === 0) {
        errors.push(`${label}: sources required`);
        continue;
      }
      let hasVerifiedSource = false;
      for (const src of model.sources) {
        if (!src.url || !/^https?:\/\//.test(src.url)) {
          errors.push(`${label}: invalid source url`);
          continue;
        }
        const hash = src.sha256?.trim() ?? "";
        if (!hash) {
          errors.push(`${label}: source ${src.kind} missing sha256`);
        } else if (!sha256Re.test(hash)) {
          errors.push(`${label}: invalid sha256 on source ${src.kind}`);
        } else {
          hasVerifiedSource = true;
        }
      }
      if (!hasVerifiedSource) {
        errors.push(`${label}: no source with valid sha256`);
      }
    }
  }

  return errors;
};

/** Probes a remote URL (HEAD, then ranged GET for hosts that reject HEAD). */
export const checkRemoteUrl = async (url) => {
  try {
    const headers = {};
    const hfToken = process.env.HF_TOKEN?.trim();
    if (hfToken) {
      headers.Authorization = `Bearer ${hfToken}`;
    }
    let res = await fetch(url, {
      method: "HEAD",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      return true;
    }
    res = await fetch(url, {
      method: "GET",
      headers: { ...headers, Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
};
