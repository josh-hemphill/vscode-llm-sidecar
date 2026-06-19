import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLlamaServerHelp } from "./capabilities.ts";
import { resolveMemoryProfile } from "./memory-profile.ts";
import { buildLlamaServerArgs } from "./server-args.ts";
import { DEFAULT_ORCHESTRATOR } from "../config/schema.ts";

const GIB = 1024 * 1024 * 1024;

test("resolveMemoryProfile picks low-RAM tier", () => {
  const profile = resolveMemoryProfile(6 * GIB, "metal");
  assert.equal(profile.ctxSize, 4096);
  assert.equal(profile.kvCacheType, "q4_0");
  assert.equal(profile.batchSize, 256);
  assert.equal(profile.allowMlock, false);
  assert.equal(profile.fitDeviceMemory, true);
});

test("resolveMemoryProfile enables flash on metal", () => {
  const profile = resolveMemoryProfile(32 * GIB, "metal");
  assert.equal(profile.flashAttention, true);
  const cpu = resolveMemoryProfile(32 * GIB, "cpu");
  assert.equal(cpu.flashAttention, false);
});

test("parseLlamaServerHelp detects modern flags", () => {
  const help = `
    -ngl, --gpu-layers N    max layers (auto)
    --fit [on|off]         fit to device memory
    --cache-type-k TYPE    k cache type
    --cache-type-v TYPE    v cache type
    --flash-attn [on|off]  flash attention
    -b, --batch-size N     batch
    -ub, --ubatch-size N   ubatch
    --mlock                mlock model
  `;
  const caps = parseLlamaServerHelp(help);
  assert.equal(caps.fit, true);
  assert.equal(caps.nglAuto, true);
  assert.equal(caps.cacheTypeK, true);
  assert.equal(caps.flashAttn, true);
  assert.equal(caps.flashAttnTakesValue, true);
  assert.equal(caps.batchSize, true);
  assert.equal(caps.ubatchSize, true);
  assert.equal(caps.mlock, true);
});

test("buildLlamaServerArgs applies fit and kv quant on laptop tier", () => {
  const profile = resolveMemoryProfile(8 * GIB, "metal");
  const caps = parseLlamaServerHelp(`
    -ngl auto --fit --fit-target --cache-type-k --cache-type-v
    --flash-attn [on|off] -b -ub --mlock
  `);
  const launch = buildLlamaServerArgs({
    settings: {
      ...DEFAULT_ORCHESTRATOR,
      ctxSize: 0,
      kvCacheType: "auto",
      fitDeviceMemory: "auto",
      flashAttention: "auto",
      batchSize: 0,
      ubatchSize: 0,
      mlock: true,
    },
    profile,
    caps,
    modelPath: "/tmp/model.gguf",
    port: 8081,
    slotSavePath: "/tmp/slots",
  });
  assert.ok(launch.args.includes("--ctx-size"));
  assert.ok(launch.args.includes("4096"));
  assert.ok(launch.args.includes("-ngl"));
  assert.ok(launch.args.includes("auto"));
  assert.ok(launch.args.includes("--fit"));
  assert.ok(launch.args.includes("--cache-type-k"));
  assert.ok(launch.args.includes("q4_0"));
  assert.ok(!launch.args.includes("--mlock"));
  assert.equal(launch.fitEnabled, true);
});

test("buildLlamaServerArgs uses numeric ngl when fit unsupported", () => {
  const profile = resolveMemoryProfile(32 * GIB, "cpu");
  const caps = parseLlamaServerHelp("--help");
  const launch = buildLlamaServerArgs({
    settings: DEFAULT_ORCHESTRATOR,
    profile,
    caps,
    modelPath: "/tmp/model.gguf",
    port: 8081,
    slotSavePath: "/tmp/slots",
  });
  assert.ok(launch.args.includes("-ngl"));
  assert.ok(launch.args.includes("-1"));
});
