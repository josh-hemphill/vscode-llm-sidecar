import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStatusBarView } from "./bar-state.ts";

describe("buildStatusBarView", () => {
  it("shows add endpoint when none configured", () => {
    const view = buildStatusBarView({
      proxyBaseUrl: undefined,
      llamaBaseUrl: undefined,
      hitlEnforced: true,
      endpointCount: 0,
      missingEndpointLabels: [],
    });
    assert.match(view.text, /add endpoint/);
    assert.equal(view.command, "llmSidecar.addFirstEndpoint");
  });

  it("shows running proxy and llama ports", () => {
    const view = buildStatusBarView({
      proxyBaseUrl: "http://127.0.0.1:3848",
      llamaBaseUrl: "http://127.0.0.1:8081",
      hitlEnforced: true,
      endpointCount: 1,
      missingEndpointLabels: [],
    });
    assert.match(view.text, /3848|p:3848/);
    assert.match(view.text, /8081|l:8081/);
  });
});
