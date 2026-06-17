import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCopilotByokSecretPlaceholder,
  resolveEndpointSecretId,
} from "./keys.ts";
import type { EndpointConfig } from "../config/schema.ts";

const sampleEndpoint = (): EndpointConfig => ({
  id: "gemini",
  upstreamUrl: "https://example.com/v1/chat/completions",
  adapter: "openai-pass-through",
});

describe("resolveEndpointSecretId", () => {
  it("uses default when apiKeySecretId omitted", () => {
    assert.equal(
      resolveEndpointSecretId(sampleEndpoint()),
      "llmSidecar.endpoint.gemini"
    );
  });

  it("uses explicit apiKeySecretId when set", () => {
    assert.equal(
      resolveEndpointSecretId({
        ...sampleEndpoint(),
        apiKeySecretId: "custom.key",
      }),
      "custom.key"
    );
  });
});

describe("buildCopilotByokSecretPlaceholder", () => {
  it("builds chat.lm.secret placeholder", () => {
    assert.equal(
      buildCopilotByokSecretPlaceholder("llmSidecar"),
      "${input:chat.lm.secret.llmSidecar}"
    );
  });
});
