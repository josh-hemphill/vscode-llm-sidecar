import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { resolveEditorUserFolder } from "./editor-paths.ts";

describe("resolveEditorUserFolder", () => {
  it("uses Code on Windows", () => {
    const base = resolveEditorUserFolder("Visual Studio Code", "win32", "C:\\Users\\me", "C:\\Users\\me\\AppData\\Roaming");
    assert.equal(base, path.join("C:\\Users\\me\\AppData\\Roaming", "Code", "User"));
  });

  it("uses Cursor folder name", () => {
    const base = resolveEditorUserFolder("Cursor", "darwin", "/home/me");
    assert.equal(base, path.join("/home/me", "Library", "Application Support", "Cursor", "User"));
  });

  it("uses Insiders folder name", () => {
    const base = resolveEditorUserFolder("Code - Insiders", "linux", "/home/me");
    assert.equal(base, path.join("/home/me", ".config", "Code - Insiders", "User"));
  });
});
