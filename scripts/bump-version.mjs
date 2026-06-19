#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "package.json");
const cargoPath = join(root, "crates", "sidecar-proxy", "Cargo.toml");
const changelogPath = join(root, "CHANGELOG.md");

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;

/** Parses a semver string into numeric parts. */
export const parseVersion = (version) => {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

/** Formats version parts as X.Y.Z. */
export const formatVersion = ({ major, minor, patch }) =>
  `${major}.${minor}.${patch}`;

/** Bumps a semver by patch, minor, or major. */
export const bumpVersion = (current, kind) => {
  const parts = parseVersion(current);
  if (kind === "patch") {
    parts.patch += 1;
  } else if (kind === "minor") {
    parts.minor += 1;
    parts.patch = 0;
  } else if (kind === "major") {
    parts.major += 1;
    parts.minor = 0;
    parts.patch = 0;
  } else {
    throw new Error(`Unknown bump kind: ${kind}`);
  }
  return formatVersion(parts);
};

/** Reads the extension version from package.json. */
export const readCurrentVersion = (pkgPath = packagePath) => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.version || typeof pkg.version !== "string") {
    throw new Error(`Missing version in ${pkgPath}`);
  }
  return pkg.version;
};

/** Resolves the next version from CLI args. */
export const resolveNextVersion = (args, current) => {
  const positional = args.filter(
    (a) => !a.startsWith("-") && args[args.indexOf(a) - 1] !== "-m" && args[args.indexOf(a) - 1] !== "--message"
  );
  const target = positional[0];
  if (!target) {
    throw new Error("Usage: bump-version.mjs <patch|minor|major|X.Y.Z> [--message text] [--tag] [--dry-run]");
  }
  if (target === "patch" || target === "minor" || target === "major") {
    return bumpVersion(current, target);
  }
  parseVersion(target);
  return target;
};

/** Updates package.json version field. */
export const updatePackageJson = (version, pkgPath = packagePath) => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
};

/** Updates sidecar-proxy Cargo.toml package version. */
export const updateCargoToml = (version, path = cargoPath) => {
  const text = readFileSync(path, "utf8");
  const next = text.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${version}"`
  );
  if (next === text) {
    throw new Error(`Could not update version in ${path}`);
  }
  writeFileSync(path, next, "utf8");
};

/** Inserts a new changelog section after the header. */
export const updateChangelog = (
  version,
  message = "TBD",
  path = changelogPath
) => {
  const text = readFileSync(path, "utf8");
  if (text.includes(`## ${version}`)) {
    throw new Error(`CHANGELOG already has section for ${version}`);
  }
  const bullet = message.trim() || "TBD";
  const section = `## ${version}\n\n- ${bullet}\n\n`;
  const header = "# Changelog\n\n";
  if (!text.startsWith(header)) {
    throw new Error("CHANGELOG.md must start with '# Changelog\\n\\n'");
  }
  writeFileSync(path, text.replace(header, `${header}${section}`), "utf8");
};

const isMain =
  resolve(fileURLToPath(import.meta.url)) ===
  resolve(process.argv[1] ?? "");

if (isMain) {
  const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const hasFlag = (name) => args.includes(name);

const dryRun = hasFlag("--dry-run");
const createTag = hasFlag("--tag");
const message = getFlag("--message") ?? getFlag("-m") ?? "TBD";

try {
  const current = readCurrentVersion();
  const next = resolveNextVersion(args, current);
  if (next === current) {
    throw new Error(`Version unchanged: ${current}`);
  }

  console.log(`bump-version: ${current} -> ${next}`);
  if (dryRun) {
    console.log("dry-run: no files changed");
    process.exit(0);
  }

  updatePackageJson(next);
  updateCargoToml(next);
  updateChangelog(next, message);
  console.log("bump-version: updated package.json, Cargo.toml, CHANGELOG.md");

  if (createTag) {
    const tag = `v${next}`;
    execSync(`git tag ${tag}`, { cwd: root, stdio: "inherit" });
    console.log(`bump-version: created tag ${tag}`);
    console.log(`Next: git add -A && git commit -m "chore: release v${next}" && git push && git push --tags`);
  } else {
    console.log(`Next: review changes, commit, then git tag v${next} && git push --tags`);
  }
} catch (err) {
  console.error(`bump-version: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
}
