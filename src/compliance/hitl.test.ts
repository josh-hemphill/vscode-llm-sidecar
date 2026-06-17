import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildToolEligibilityDenyAll } from "./hitl-policy.ts";

describe("buildToolEligibilityDenyAll", () => {
  it("marks default and extra tools as ineligible for auto approval", () => {
    const map = buildToolEligibilityDenyAll(["custom_tool"]);
    assert.equal(map.readFile, false);
    assert.equal(map.custom_tool, false);
    assert.equal(map.runInTerminal, false);
  });

  it("denies previously allowed tools when passed as existing keys", () => {
    const map = buildToolEligibilityDenyAll(["legacy_tool"]);
    assert.equal(map.legacy_tool, false);
  });
});
