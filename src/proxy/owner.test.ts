import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  clearProxyOwnerFromDir,
  readProxyOwnerFromDir,
  writeProxyOwnerToDir,
} from "./proxy-owner-fs.ts";

describe("proxy owner file", () => {
  it("writes reads and clears owner record", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-test-"));
    await writeProxyOwnerToDir(dir, 4242, 3847);
    const record = await readProxyOwnerFromDir(dir);
    assert.equal(record?.pid, 4242);
    assert.equal(record?.port, 3847);
    assert.ok(record?.startedAt);
    await clearProxyOwnerFromDir(dir);
    assert.equal(await readProxyOwnerFromDir(dir), undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
