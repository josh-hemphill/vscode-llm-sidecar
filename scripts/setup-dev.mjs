#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const run = (cmd, cmdArgs) => {
  const res = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
};

console.log("==> build:proxy");
run("pnpm", ["run", "build:proxy"]);

console.log("==> fetch:llama-server");
run("node", ["scripts/fetch-llama-server.mjs"]);

console.log("==> fetch:model (default)");
run("node", ["scripts/fetch-model.mjs", "--id", "default"]);

console.log("==> compile");
run("pnpm", ["run", "compile"]);

console.log("setup:dev complete");
