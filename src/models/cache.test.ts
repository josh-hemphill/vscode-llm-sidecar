import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  emptyCache,
  isCacheEntryStale,
  readModelCache,
  shouldRefetchEndpointCache,
  writeModelCache,
} from "./cache-store.ts";

describe("isCacheEntryStale", () => {
  it("is stale when entry missing", () => {
    assert.equal(isCacheEntryStale(undefined, 60), true);
  });

  it("is fresh within ttl", () => {
    const entry = {
      fetchedAt: new Date().toISOString(),
      sourceUrl: "http://x/models",
      models: [{ id: "a" }],
    };
    assert.equal(isCacheEntryStale(entry, 60), false);
  });

  it("is stale after ttl", () => {
    const old = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    const entry = {
      fetchedAt: old,
      sourceUrl: "http://x/models",
      models: [{ id: "a" }],
    };
    assert.equal(isCacheEntryStale(entry, 60), true);
  });
});

describe("shouldRefetchEndpointCache", () => {
  it("refetches when cache entry is missing or empty", () => {
    const fresh = {
      fetchedAt: new Date().toISOString(),
      sourceUrl: "http://x/models",
      models: [{ id: "a" }],
    };
    assert.equal(shouldRefetchEndpointCache(undefined, 60), true);
    assert.equal(
      shouldRefetchEndpointCache({ ...fresh, models: [] }, 60),
      true
    );
    assert.equal(shouldRefetchEndpointCache(fresh, 60), false);
  });

  it("refetches when stale", () => {
    const old = {
      fetchedAt: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
      sourceUrl: "http://x/models",
      models: [{ id: "a" }],
    };
    assert.equal(shouldRefetchEndpointCache(old, 60), true);
  });
});

describe("readModelCache / writeModelCache", () => {
  it("round-trips cache file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-test-"));
    const cachePath = path.join(dir, "models-cache.json");
    const cache = emptyCache();
    cache.endpoints.ep1 = {
      fetchedAt: new Date().toISOString(),
      sourceUrl: "http://example/v1/models",
      models: [{ id: "m1", name: "M1" }],
    };
    await writeModelCache(cachePath, cache);
    const read = await readModelCache(cachePath);
    assert.equal(read.endpoints.ep1?.models[0]?.id, "m1");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
