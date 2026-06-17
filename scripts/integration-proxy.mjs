import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe =
  process.platform === "win32" ? "sidecar-proxy.exe" : "sidecar-proxy";
const platformArch = `${process.platform}-${process.arch}`;

const binaryCandidates = [
  join(root, "bin", platformArch, exe),
  join(root, "bin", exe),
  join(root, "target", "release", exe),
  join(root, "target", "debug", exe),
];

const findBinary = () => {
  const direct = binaryCandidates.find((p) => existsSync(p));
  if (direct) {
    return direct;
  }
  const binRoot = join(root, "bin");
  if (!existsSync(binRoot)) {
    return undefined;
  }
  for (const dir of readdirSync(binRoot)) {
    const candidate = join(binRoot, dir, exe);
    if (existsSync(candidate)) {
      console.warn(
        `integration-proxy: using ${candidate} (no exact match for ${platformArch})`
      );
      return candidate;
    }
  }
  return undefined;
};

const binary = findBinary();
if (!binary) {
  console.error(
    `integration-proxy: no binary found for ${platformArch}; run cargo build -p sidecar-proxy or layout-release-binaries`
  );
  process.exit(1);
}

const initialPayload = {
  profiles: {},
  orchestrator: { llamaBaseUrl: "http://127.0.0.1:8081", workspace: { roots: [], openFiles: [], recentFiles: [], diagnostics: [] } },
  endpoints: [
    {
      id: "test",
      upstreamUrl: "http://127.0.0.1:9/v1/chat/completions",
      adapter: "openai-pass-through",
      models: [{ id: "model-one", name: "Model One", toolCalling: true }],
    },
  ],
};

const reloadPayload = {
  ...initialPayload,
  endpoints: [
    {
      ...initialPayload.endpoints[0],
      models: [
        { id: "model-one", name: "Model One", toolCalling: true },
        { id: "model-two", name: "Model Two", toolCalling: false },
      ],
    },
  ],
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchJson = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
};

const run = async () => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-integ-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(initialPayload));

  const port = 38777;
  const adminToken = "integration-test-admin-token";
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      NO_COLOR: "1",
      LLM_SIDECAR_PORT: String(port),
      LLM_SIDECAR_CONFIG_PATH: configPath,
      LLM_SIDECAR_ADMIN_TOKEN: adminToken,
    },
    stdio: "ignore",
  });

  let failed = false;
  try {
    for (let i = 0; i < 40; i += 1) {
      if (child.exitCode !== null) {
        throw new Error(`proxy exited early with code ${child.exitCode}`);
      }
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.ok) break;
      } catch {
        /* retry */
      }
      await wait(250);
    }

    const health = await fetchJson(`http://127.0.0.1:${port}/health`);
    if (!health.ok) {
      throw new Error(`health failed: ${health.status}`);
    }

    const reload = await fetchJson(`http://127.0.0.1:${port}/admin/reload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-llm-sidecar-admin-token": adminToken,
      },
      body: JSON.stringify(reloadPayload),
    });
    if (!reload.ok) {
      throw new Error(`reload failed: ${reload.status}`);
    }

    const models = await fetchJson(`http://127.0.0.1:${port}/v1/models`);
    if (!models.ok) {
      throw new Error(`models failed: ${models.status}`);
    }
    const ids = (models.body?.data ?? []).map((m) => m.id).sort();
    if (!ids.includes("model-one") || !ids.includes("model-two")) {
      throw new Error(`unexpected models: ${ids.join(", ")}`);
    }

    console.log("integration-proxy: ok");
  } catch (err) {
    failed = true;
    console.error(`integration-proxy: ${err.message}`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await wait(400);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  // Defer exit so the child process can close cleanly on Windows.
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
};

run();
