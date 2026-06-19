import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  bumpVersion,
  formatVersion,
  parseVersion,
  updateCargoToml,
  updateChangelog,
  updatePackageJson,
} from "./bump-version.mjs";

test("parseVersion and bumpVersion", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(formatVersion({ major: 3, minor: 0, patch: 1 }), "3.0.1");
});

test("updatePackageJson writes version", () => {
  const dir = join(process.cwd(), ".tmp-bump-version");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pkgPath = join(dir, "package.json");
  writeFileSync(pkgPath, JSON.stringify({ name: "x", version: "1.0.0" }, null, 2));
  updatePackageJson("1.0.1", pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.version, "1.0.1");
  rmSync(dir, { recursive: true, force: true });
});

test("updateCargoToml writes version", () => {
  const dir = join(process.cwd(), ".tmp-bump-cargo");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "Cargo.toml");
  writeFileSync(path, '[package]\nname = "sidecar-proxy"\nversion = "1.0.0"\n');
  updateCargoToml("1.0.1", path);
  assert.match(readFileSync(path, "utf8"), /version = "1.0.1"/);
  rmSync(dir, { recursive: true, force: true });
});

test("updateChangelog inserts new section", () => {
  const dir = join(process.cwd(), ".tmp-bump-changelog");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "CHANGELOG.md");
  writeFileSync(path, "# Changelog\n\n## 1.0.0\n\n- Initial\n");
  updateChangelog("1.0.1", "Fix bug", path);
  const text = readFileSync(path, "utf8");
  assert.ok(text.startsWith("# Changelog\n\n## 1.0.1\n\n- Fix bug\n\n## 1.0.0"));
  rmSync(dir, { recursive: true, force: true });
});
