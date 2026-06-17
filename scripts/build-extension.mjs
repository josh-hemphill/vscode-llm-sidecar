import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });
cpSync("assets/runtime-manifest.json", "dist/assets/runtime-manifest.json");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("esbuild: watching extension…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
