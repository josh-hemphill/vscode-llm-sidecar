import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelsResponse } from "./parse-models-response.ts";

describe("parseModelsResponse", () => {
  it("parses OpenAI data envelope", () => {
    const rows = parseModelsResponse({
      data: [
        { id: "gpt-4", name: "GPT-4" },
        { id: "gpt-3.5" },
      ],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.id, "gpt-4");
    assert.equal(rows[0]?.name, "GPT-4");
    assert.equal(rows[1]?.name, undefined);
  });

  it("parses bare array", () => {
    const rows = parseModelsResponse([{ id: "llama" }, { id: "mistral", name: "Mistral" }]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.id, "llama");
  });

  it("returns empty for invalid input", () => {
    assert.deepEqual(parseModelsResponse(null), []);
    assert.deepEqual(parseModelsResponse({}), []);
    assert.deepEqual(parseModelsResponse({ data: "nope" }), []);
    assert.deepEqual(parseModelsResponse([{ name: "no-id" }]), []);
  });

  it("handles nested data array", () => {
    const rows = parseModelsResponse({ object: "list", data: [{ id: "a" }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "a");
  });
});
