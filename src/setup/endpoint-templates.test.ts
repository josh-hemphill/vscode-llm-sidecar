import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uniqueEndpointId } from "./endpoint-templates.ts";

describe("uniqueEndpointId", () => {
  it("returns base id when unused", () => {
    assert.equal(uniqueEndpointId("gemini", []), "gemini");
  });

  it("appends numeric suffix on collision", () => {
    const existing = [{ id: "gemini", upstreamUrl: "u", adapter: "openai-pass-through" as const }];
    assert.equal(uniqueEndpointId("gemini", existing), "gemini-2");
  });
});
