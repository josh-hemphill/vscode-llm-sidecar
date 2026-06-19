#!/usr/bin/env node
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};

const platform = getFlag("--target") ?? `${process.platform}-${process.arch}`;
const out = getFlag("--out") ?? join(root, `llm-sidecar-${platform}.vsix`);

const extraArgs = args.filter((a, i) => {
  if (a === "--target" || a === "--out") {
    return false;
  }
  if (args[i - 1] === "--target" || args[i - 1] === "--out") {
    return false;
  }
  return true;
});

const cmd = [
  "pnpm",
  "dlx",
  "@vscode/vsce",
  "package",
  "--no-dependencies",
  "--target",
  platform,
  "--out",
  out,
  ...extraArgs,
].join(" ");

execSync(cmd, { cwd: root, stdio: "inherit" });
console.log(`create-vsix: ${out}`);
