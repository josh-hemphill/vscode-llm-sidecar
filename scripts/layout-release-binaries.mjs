import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Copies downloaded CI artifacts into bin/<platform>-<arch>/ for vsce package. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = process.argv[2] ?? join(root, "artifacts");

let copied = 0;

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!name.startsWith("sidecar-proxy") && !name.startsWith("llama-server")) {
      continue;
    }
    const platformArch = dirname(full).split(/[/\\]/).pop();
    if (!platformArch?.includes("-")) {
      console.warn(
        `layout-release-binaries: skip ${full} (expected parent like linux-x64)`
      );
      continue;
    }
    const destDir = join(root, "bin", platformArch);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, name);
    cpSync(full, dest);
    copied += 1;
    console.log(`layout-release-binaries: ${dest}`);
  }
};

if (existsSync(artifactsDir)) {
  walk(artifactsDir);
} else {
  console.warn(`layout-release-binaries: no artifacts at ${artifactsDir}`);
}

if (copied === 0) {
  console.error(
    "layout-release-binaries: no sidecar or llama binaries found"
  );
  process.exit(1);
}
