import { ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";
import {
  ADMIN_TOKEN_HEADER,
  generateAdminToken,
  withAdminTokenEnv,
} from "./admin-token.ts";
import {
  buildProxyPayload,
  getSettings,
  loadModelCacheForContext,
  proxyBinaryCandidates,
  resolveModelsForContext,
  resolveProxyBinary,
} from "../config/store.ts";
import { gatherWorkspaceContext } from "../context/workspace.ts";
import {
  getLlamaBaseUrl,
  startLlamaServer,
  stopLlamaServer,
} from "../llama/process.ts";
export {
  getLlamaBaseUrl,
  isLlamaRunning,
  startLlamaServer,
  stopLlamaServer,
} from "../llama/process.ts";
import { writeProxyConfigFile } from "./config-file.ts";
import { probeProxyHealth } from "./health.ts";
import { appendAuditEntry } from "../compliance/audit.ts";
import { withLifecycleLock } from "./lifecycle-mutex.ts";
import { getOutputChannel } from "./output-channel.ts";
import { clearProxyOwner, readProxyOwner, writeProxyOwner } from "./owner.ts";
import { stripAnsi } from "./strip-ansi.ts";
import {
  countPayloadModels,
  fetchModelCatalogFromProxy,
} from "./catalog.ts";
import { buildCatalogFromResolved } from "../models/merge.ts";
import { refreshModelCacheIfNeeded } from "../models/discover.ts";

export { getOutputChannel } from "./output-channel.ts";

export interface ProxyHandle {
  port: number;
  baseUrl: string;
}

let child: ChildProcess | undefined;
let currentPort = 0;
let attachedExternal = false;
let adminToken: string | undefined;
let bootstrapPromise: Promise<void> | undefined;

const proxyBaseUrl = (port: number): string => `http://127.0.0.1:${port}`;

export const isRunning = (): boolean =>
  (child !== undefined && child.exitCode === null) || attachedExternal;

export const getProxyBaseUrl = (): string | undefined =>
  isRunning() && currentPort > 0 ? proxyBaseUrl(currentPort) : undefined;

const clearLocalProxyState = (): void => {
  child = undefined;
  attachedExternal = false;
  currentPort = 0;
  adminToken = undefined;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForHealth = async (
  port: number,
  proc: ChildProcess,
  attempts = 40
): Promise<boolean> => {
  for (let i = 0; i < attempts; i += 1) {
    if (proc.exitCode !== null) {
      return false;
    }
    if (await probeProxyHealth(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

/** POST current settings to a running proxy and persist redacted config on disk. */
const applyProxyPayload = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  port: number,
  options?: { allowEmpty?: boolean }
): Promise<boolean> => {
  const cache = await loadModelCacheForContext(context);
  const settings = getSettings();
  const workspace = await gatherWorkspaceContext();
  const payload = await buildProxyPayload(context, settings, cache, workspace);
  for (const ep of payload.endpoints) {
    log.appendLine(
      `Endpoint "${ep.id}" adapter=${ep.adapter} upstream=${ep.upstreamUrl}`
    );
  }
  const modelCount = countPayloadModels(payload);
  if (modelCount === 0 && !options?.allowEmpty) {
    const proxyCatalog = await fetchModelCatalogFromProxy(proxyBaseUrl(port));
    if (proxyCatalog.models.length > 0) {
      log.appendLine(
        `Skipped proxy reload: local catalog empty but proxy has ${proxyCatalog.models.length} model(s)`
      );
      return true;
    }
  }
  await writeProxyConfigFile(context, payload);
  if (!adminToken) {
    log.appendLine("Reload skipped: admin token unavailable");
    return false;
  }
  try {
    const res = await fetch(`${proxyBaseUrl(port)}/admin/reload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ADMIN_TOKEN_HEADER]: adminToken,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.appendLine(`Reload failed: ${res.status}`);
      return false;
    }
    log.appendLine("Proxy config reloaded");
    await appendAuditEntry(context, {
      timestamp: new Date().toISOString(),
      endpointId: payload.endpoints[0]?.id ?? "proxy",
      model: "config-reload",
      upstreamUrl: payload.endpoints[0]?.upstreamUrl ?? "",
      emittedToolCalls: [],
      localOnly: payload.orchestrator.localOnly,
    });
    return true;
  } catch (err) {
    log.appendLine(`Reload error: ${String(err)}`);
    return false;
  }
};

const attachToExistingProxy = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  port: number
): Promise<boolean> => {
  if (!(await probeProxyHealth(port))) {
    return false;
  }
  const owner = await readProxyOwner(context);
  if (owner?.pid && !isProcessAlive(owner.pid)) {
    log.appendLine(
      `Proxy owner pid ${owner.pid} is not running; refusing attach`
    );
    return false;
  }
  if (owner?.pid) {
    log.appendLine(
      `Attaching to existing proxy on port ${port} (owner pid ${owner.pid})`
    );
  } else {
    log.appendLine(`Attaching to existing proxy on port ${port}`);
  }
  currentPort = port;
  attachedExternal = true;
  log.appendLine("Attached without reloading proxy config (preserves shared catalog)");
  return true;
};

/** Starts sidecar-proxy and optionally llama-server. */
export const startProxy = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  options?: { skipDiscovery?: boolean; skipLlama?: boolean }
): Promise<ProxyHandle | undefined> =>
  withLifecycleLock(async () => {
    const settings = getSettings();

    if (!options?.skipLlama && settings.autoStartLlama) {
      await startLlamaServer(context, log);
    }

    if (isRunning() && currentPort > 0) {
      await applyProxyPayload(context, log, currentPort);
      return { port: currentPort, baseUrl: proxyBaseUrl(currentPort) };
    }

    const port = settings.proxyPort;

    if (!options?.skipDiscovery) {
      await refreshModelCacheIfNeeded(context, log);
    }

    if (await probeProxyHealth(port)) {
      const attached = await attachToExistingProxy(context, log, port);
      if (attached) {
        await applyProxyPayload(context, log, port);
        return { port, baseUrl: proxyBaseUrl(port) };
      }
    }

    const cache = await loadModelCacheForContext(context);
    const binary = resolveProxyBinary(settings, context.extensionPath);
    if (!binary) {
      const tried = proxyBinaryCandidates(settings, context.extensionPath);
      log.appendLine("Proxy binary not found. Tried:");
      for (const p of tried) {
        log.appendLine(`  ${p}`);
      }
      void vscode.window.showErrorMessage(
        "LLM Sidecar: proxy binary not found. Run `pnpm run build:proxy` or set llmSidecar.proxyBinaryPath."
      );
      return undefined;
    }

    const workspace = await gatherWorkspaceContext();
    const payload = await buildProxyPayload(context, settings, cache, workspace);
    const llamaUrl = getLlamaBaseUrl() ?? settings.orchestrator.llamaBaseUrl;
    payload.orchestrator.llamaBaseUrl = llamaUrl;

    adminToken = generateAdminToken();
    const { path: configPath, bytes: configBytes } = await writeProxyConfigFile(
      context,
      payload
    );
    const modelCount = payload.endpoints.reduce(
      (n, ep) => n + (ep.models?.length ?? 0),
      0
    );
    log.appendLine(
      `Starting proxy: ${binary} (${modelCount} models, config ${configBytes} bytes)`
    );
    currentPort = port;
    attachedExternal = false;

    let spawnError: string | undefined;
    child = spawn(binary, [], {
      env: withAdminTokenEnv(
        {
          ...process.env,
          NO_COLOR: "1",
          LLM_SIDECAR_PORT: String(port),
          LLM_SIDECAR_CONFIG_PATH: configPath,
        },
        adminToken
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (err) => {
      spawnError = err.message;
      log.appendLine(`Proxy spawn error: ${err.message}`);
    });
    const appendProxyLog = (chunk: Buffer): void => {
      log.append(stripAnsi(chunk.toString()));
    };
    child.stdout?.on("data", appendProxyLog);
    child.stderr?.on("data", appendProxyLog);
    child.on("exit", (code) => {
      log.appendLine(`Proxy exited with code ${code ?? "unknown"}`);
      void clearProxyOwner(context);
      clearLocalProxyState();
    });

    const healthy = await waitForHealth(port, child);
    if (!healthy) {
      const exitCode = child.exitCode;
      log.appendLine(
        `Proxy failed health check${exitCode !== null ? ` (exit ${exitCode})` : ""}${spawnError ? `: ${spawnError}` : ""}`
      );
      child = undefined;
      attachedExternal = false;
      if (await probeProxyHealth(port)) {
        log.appendLine("Another proxy is already listening; attaching instead.");
        if (await attachToExistingProxy(context, log, port)) {
          return { port, baseUrl: proxyBaseUrl(port) };
        }
      }
      await stopProxy(context);
      void vscode.window.showErrorMessage(
        "LLM Sidecar: proxy failed to start. See output channel."
      );
      return undefined;
    }

    await applyProxyPayload(context, log, port, { allowEmpty: true });

    if (child.pid !== undefined) {
      await writeProxyOwner(context, child.pid, port);
      log.appendLine(
        `Proxy listening on http://127.0.0.1:${port} (pid ${child.pid})`
      );
    } else {
      log.appendLine(`Proxy listening on http://127.0.0.1:${port}`);
    }
    return { port, baseUrl: proxyBaseUrl(port) };
  });

/** Stops proxy and llama-server processes owned by this window. */
export const stopProxy = async (
  context: vscode.ExtensionContext
): Promise<void> =>
  withLifecycleLock(async () => {
    if (child !== undefined && child.exitCode === null) {
      child.kill();
      await clearProxyOwner(context);
    }
    clearLocalProxyState();
    await stopLlamaServer(context);
  });

export const reloadProxyConfig = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel
): Promise<boolean> =>
  withLifecycleLock(async () => {
    const port = getSettings().proxyPort;
    if (!isRunning() || currentPort <= 0) {
      if (!(await attachToExistingProxy(context, log, port))) {
        return false;
      }
    }
    if (!(await probeProxyHealth(currentPort))) {
      clearLocalProxyState();
      return false;
    }
    return applyProxyPayload(context, log, currentPort);
  });

export const buildModelCatalog = async (
  context: vscode.ExtensionContext,
  baseUrl: string
): Promise<import("../config/schema.ts").ModelCatalog> => {
  const resolved = await resolveModelsForContext(context);
  const local = buildCatalogFromResolved(baseUrl, resolved);
  if (local.models.length > 0) {
    return local;
  }
  const fromProxy = await fetchModelCatalogFromProxy(baseUrl);
  if (fromProxy.models.length > 0) {
    return fromProxy;
  }
  return local;
};

export const trackBootstrap = (promise: Promise<void>): void => {
  bootstrapPromise = promise;
};

export const awaitBootstrap = async (): Promise<void> => {
  if (bootstrapPromise) {
    await bootstrapPromise;
  }
};
