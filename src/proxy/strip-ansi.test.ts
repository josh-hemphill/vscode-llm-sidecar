import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "./strip-ansi.ts";

describe("stripAnsi", () => {
  it("removes tracing color codes", () => {
    const raw = "\u001b[2m2026-05-30T05:29:39Z\u001b[0m \u001b[32m INFO\u001b[0m normalizer_proxy";
    const plain = stripAnsi(raw);
    assert.ok(!plain.includes("\u001b"));
    assert.ok(plain.includes("INFO"));
    assert.ok(plain.includes("normalizer_proxy"));
  });

  it("leaves plain text unchanged", () => {
    assert.equal(stripAnsi("hello"), "hello");
  });
});
