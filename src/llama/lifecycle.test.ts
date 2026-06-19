import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLlamaStartMode } from "./start-mode.ts";

test("resolveLlamaStartMode treats autoStartLlama false as manual", () => {
  assert.equal(resolveLlamaStartMode(false, "onActivate"), "manual");
  assert.equal(resolveLlamaStartMode(false, "onDemand"), "manual");
  assert.equal(resolveLlamaStartMode(true, "onDemand"), "onDemand");
  assert.equal(resolveLlamaStartMode(true, "onActivate"), "onActivate");
});
