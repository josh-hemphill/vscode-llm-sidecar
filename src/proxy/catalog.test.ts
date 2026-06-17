import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countPayloadModels, fetchModelCatalogFromProxy } from "./catalog.ts";

describe("countPayloadModels", () => {
  it("sums models across endpoints", () => {
    const n = countPayloadModels({
      endpoints: [
        { models: [{}, {}] },
        { models: [{}] },
        {},
      ],
    });
    assert.equal(n, 3);
  });
});

describe("fetchModelCatalogFromProxy", () => {
  it("returns empty catalog on failed fetch", async () => {
    const catalog = await fetchModelCatalogFromProxy("http://127.0.0.1:1");
    assert.equal(catalog.models.length, 0);
    assert.equal(catalog.proxyBaseUrl, "http://127.0.0.1:1");
  });
});
