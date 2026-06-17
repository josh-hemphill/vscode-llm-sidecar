import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveModelsPathname, deriveModelsUrl, normalizeUpstreamChatUrl } from "./urls.ts";

describe("normalizeUpstreamChatUrl", () => {
  it("appends chat completions to gemini openai base", () => {
    assert.equal(
      normalizeUpstreamChatUrl(
        "https://generativelanguage.googleapis.com/v1beta/openai"
      ),
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
  });

  it("leaves full completions url unchanged", () => {
    const url = "https://api.example.com/v1/chat/completions";
    assert.equal(normalizeUpstreamChatUrl(url), url);
  });
});

describe("deriveModelsUrl", () => {
  it("replaces chat/completions suffix", () => {
    assert.equal(
      deriveModelsUrl("https://api.example.com/v1/chat/completions"),
      "https://api.example.com/v1/models"
    );
  });

  it("appends models when url ends with /v1", () => {
    assert.equal(
      deriveModelsUrl("https://api.example.com/v1"),
      "https://api.example.com/v1/models"
    );
  });

  it("uses sibling /models for bare openai path", () => {
    assert.equal(
      deriveModelsUrl("https://proxy.example.com/openai"),
      "https://proxy.example.com/openai/models"
    );
  });

  it("derives Gemini v1beta openai chat completions", () => {
    assert.equal(
      deriveModelsUrl(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      ),
      "https://generativelanguage.googleapis.com/v1beta/openai/models"
    );
  });

  it("derives Gemini v1beta openai base without chat segment", () => {
    assert.equal(
      deriveModelsUrl(
        "https://generativelanguage.googleapis.com/v1beta/openai"
      ),
      "https://generativelanguage.googleapis.com/v1beta/openai/models"
    );
  });

  it("does not append /v1/models to v1beta openai base", () => {
    const result = deriveModelsUrl(
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
    assert.ok(!result.includes("/v1/models"));
    assert.ok(result.endsWith("/v1beta/openai/models"));
  });

  it("derives v1beta-only base to openai/models", () => {
    assert.equal(
      deriveModelsUrl("https://generativelanguage.googleapis.com/v1beta"),
      "https://generativelanguage.googleapis.com/v1beta/openai/models"
    );
  });

  it("strips query string before deriving", () => {
    assert.equal(
      deriveModelsUrl(
        "https://api.example.com/v1/chat/completions?api-version=2024-01-01"
      ),
      "https://api.example.com/v1/models"
    );
  });

  it("derives custom gateway openai chat path", () => {
    assert.equal(
      deriveModelsUrl("https://proxy.example.com/openai/chat/completions"),
      "https://proxy.example.com/openai/models"
    );
  });
});

describe("deriveModelsPathname", () => {
  it("handles pathname only", () => {
    assert.equal(
      deriveModelsPathname("/v1beta/openai/chat/completions"),
      "/v1beta/openai/models"
    );
  });
});
