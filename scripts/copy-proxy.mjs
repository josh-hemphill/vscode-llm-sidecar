import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe =
  process.platform === "win32" ? "sidecar-proxy.exe" : "sidecar-proxy";
const src = join(root, "target", "release", exe);
const platformArch = `${process.platform}-${process.arch}`;
const destFlat = join(root, "bin", exe);
const destArch = join(root, "bin", platformArch, exe);

if (!existsSync(src)) {
  console.error(`copy-proxy: missing ${src} — run cargo build --release -p sidecar-proxy`);
  process.exit(1);
}
for (const dest of [destArch, destFlat]) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copy-proxy: ${dest}`);
}
