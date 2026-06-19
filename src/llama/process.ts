import { ChildProcess, spawn } from "node:child_process";
import * as os from "node:os";
import * as vscode from "vscode";
import { getSettings } from "../config/store.ts";
import { resolveLlamaServerBinary } from "./binary.ts";
import { resolveModelAsset } from "./model-assets.ts";
import { describeLlamaExitCode } from "./runtime-bundle.ts";
import { stripAnsi } from "../proxy/strip-ansi.ts";
import {
  clearLlamaOwnerFromDir,
  readLlamaOwnerFromDir,
  writeLlamaOwnerToDir,
} from "./llama-owner-fs.ts";
import { detectLlamaServerCapabilities } from "./capabilities.ts";
import { resolveLlamaVariantSetting } from "./detect-backend.ts";
import { resolveMemoryProfile } from "./memory-profile.ts";
import { buildLlamaServerArgs } from "./server-args.ts";
import * as path from "node:path";

export interface LlamaHandle {
  port: number;
  baseUrl: string;
}

let child: ChildProcess | undefined;
let currentPort = 0;
let attachedExternal = false;
let ownsProcess = false;

const llamaBaseUrl = (port: number): string => `http://127.0.0.1:${port}`;

export const isLlamaRunning = (): boolean =>
  (child !== undefined && child.exitCode === null) || attachedExternal;

/** True when this window spawned llama-server (eligible for idle stop / restart). */
export const ownsLlamaProcess = (): boolean => ownsProcess;

export const getLlamaBaseUrl = (): string | undefined =>
  isLlamaRunning() && currentPort > 0 ? llamaBaseUrl(currentPort) : undefined;

const clearLlamaState = (): void => {
  child = undefined;
  attachedExternal = false;
  currentPort = 0;
  ownsProcess = false;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Probes llama-server /health endpoint. */
export const probeLlamaHealth = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`${llamaBaseUrl(port)}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const waitForLlamaHealth = async (
  port: number,
  proc: ChildProcess,
  attempts = 60
): Promise<boolean> => {
  for (let i = 0; i < attempts; i += 1) {
    if (proc.exitCode !== null) {
      return false;
    }
    if (await probeLlamaHealth(port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

/** Starts llama-server with the resolved orchestrator GGUF model. */
export const startLlamaServer = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel
): Promise<LlamaHandle | undefined> => {
  if (isLlamaRunning() && currentPort > 0) {
    return { port: currentPort, baseUrl: llamaBaseUrl(currentPort) };
  }

  const settings = getSettings();
  const port = settings.orchestrator.llamaPort;
  const ownerBase = context.globalStorageUri.fsPath;
  if (await probeLlamaHealth(port)) {
    const owner = await readLlamaOwnerFromDir(ownerBase);
    if (owner?.pid && !isProcessAlive(owner.pid)) {
      log.appendLine(
        `llama owner pid ${owner.pid} is not running; starting new llama-server`
      );
    } else {
      currentPort = port;
      attachedExternal = true;
      ownsProcess = false;
      log.appendLine(`Attaching to existing llama-server on port ${port}`);
      return { port, baseUrl: llamaBaseUrl(port) };
    }
  }

  const binary = resolveLlamaServerBinary(settings, context.extensionPath);
  if (!binary) {
    log.appendLine("llama-server binary not found. Set llmSidecar.orchestrator.llamaServerBinaryPath.");
    return undefined;
  }

  const model = await resolveModelAsset(context, {
    modelPath: settings.orchestrator.modelPath,
    modelMirrorUrl: settings.orchestrator.modelMirrorUrl,
    modelReleaseAsset: settings.orchestrator.modelReleaseAsset,
    selectedModelId: settings.orchestrator.selectedModelId,
  });
  if (!model) {
    log.appendLine("Bind-model GGUF not found. Run LLM Sidecar: Download Bind Model.");
    return undefined;
  }

  currentPort = port;
  attachedExternal = false;
  ownsProcess = true;

  const variant = resolveLlamaVariantSetting(settings.orchestrator.llamaServerVariant);
  const profile = resolveMemoryProfile(os.totalmem(), variant);
  const caps = detectLlamaServerCapabilities(binary);
  const launch = buildLlamaServerArgs({
    settings: settings.orchestrator,
    profile,
    caps,
    modelPath: model.path,
    port,
    slotSavePath: context.globalStorageUri.fsPath,
  });
  const args = launch.args;

  log.appendLine(
    `llama launch profile: ctx=${launch.ctxSize} kv=${launch.kvCacheType} fit=${launch.fitEnabled} flash=${launch.flashAttention} ram=${Math.round(os.totalmem() / (1024 ** 3))}GB variant=${variant}`
  );
  log.appendLine(`Starting llama-server: ${binary} (${model.source})`);
  child = spawn(binary, args, {
    cwd: path.dirname(binary),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.on("error", (err) => {
    log.appendLine(`llama-server spawn error: ${err.message}`);
  });
  const appendLog = (chunk: Buffer): void => {
    log.append(stripAnsi(chunk.toString()));
  };
  child.stdout?.on("data", appendLog);
  child.stderr?.on("data", appendLog);
  child.on("exit", (code) => {
    log.appendLine(`llama-server exited with code ${code ?? "unknown"}`);
    const hint = describeLlamaExitCode(code ?? null);
    if (hint) {
      log.appendLine(hint);
      void vscode.window.showErrorMessage(`LLM Sidecar: ${hint}`);
    }
    void clearLlamaOwnerFromDir(ownerBase);
    clearLlamaState();
  });

  if (!child || !(await waitForLlamaHealth(port, child))) {
    log.appendLine("llama-server failed health check");
    await stopLlamaServer(context);
    return undefined;
  }

  if (child.pid !== undefined) {
    await writeLlamaOwnerToDir(ownerBase, child.pid, port);
    log.appendLine(`llama-server listening on ${llamaBaseUrl(port)} (pid ${child.pid})`);
  } else {
    log.appendLine(`llama-server listening on ${llamaBaseUrl(port)}`);
  }
  return { port, baseUrl: llamaBaseUrl(port) };
};

/** Stops llama-server if spawned by this window. */
export const stopLlamaServer = async (
  context?: vscode.ExtensionContext
): Promise<void> => {
  if (!ownsProcess) {
    clearLlamaState();
    return;
  }
  if (child !== undefined && child.exitCode === null) {
    child.kill();
  }
  if (context) {
    await clearLlamaOwnerFromDir(context.globalStorageUri.fsPath);
  }
  clearLlamaState();
};
