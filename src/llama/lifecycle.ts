import * as vscode from "vscode";
import { getSettings } from "../config/store.ts";
import {
  isLlamaRunning,
  ownsLlamaProcess,
  startLlamaServer,
  stopLlamaServer,
} from "./process.ts";
import { reloadProxyConfig } from "../proxy/process.ts";
import { ADMIN_TOKEN_HEADER } from "../proxy/admin-token.ts";
import { resolveLlamaStartMode } from "./start-mode.ts";

export { resolveLlamaStartMode } from "./start-mode.ts";

export interface ProxyActivitySnapshot {
  lastUseMs: number;
  wantedMs: number;
  nowMs: number;
  up: boolean;
}

const POLL_MS = 2000;

let interval: ReturnType<typeof setInterval> | undefined;
let lastStartAttemptMs = 0;

const fetchProxyStatus = async (
  port: number,
  adminToken: string | undefined
): Promise<ProxyActivitySnapshot | undefined> => {
  if (!adminToken) {
    return undefined;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/status`, {
      headers: { [ADMIN_TOKEN_HEADER]: adminToken },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as {
      lastUseMs?: number;
      wantedMs?: number;
      nowMs?: number;
      up?: boolean;
    };
    return {
      lastUseMs: body.lastUseMs ?? 0,
      wantedMs: body.wantedMs ?? 0,
      nowMs: body.nowMs ?? Date.now(),
      up: body.up ?? false,
    };
  } catch {
    return undefined;
  }
};

/** Polls proxy activity and starts/stops llama based on on-demand and idle settings. */
export const startLlamaLifecycleManager = (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  getAdminToken: () => string | undefined
): void => {
  if (interval) {
    return;
  }
  interval = setInterval(() => {
    void (async () => {
      const settings = getSettings();
      const startMode = resolveLlamaStartMode(
        settings.autoStartLlama,
        settings.orchestrator.llamaStartMode
      );
      const status = await fetchProxyStatus(
        settings.proxyPort,
        getAdminToken()
      );
      if (!status) {
        return;
      }

      if (
        startMode === "onDemand" &&
        !isLlamaRunning() &&
        status.wantedMs > lastStartAttemptMs
      ) {
        lastStartAttemptMs = status.nowMs;
        log.appendLine("llama lifecycle: on-demand start requested by proxy");
        const handle = await startLlamaServer(context, log);
        if (handle) {
          await reloadProxyConfig(context, log);
        }
        return;
      }

      const idleSec = settings.orchestrator.llamaIdleTimeoutSec;
      if (
        idleSec > 0 &&
        ownsLlamaProcess() &&
        isLlamaRunning() &&
        status.lastUseMs > 0 &&
        status.nowMs - status.lastUseMs > idleSec * 1000
      ) {
        log.appendLine(
          `llama lifecycle: stopping after ${idleSec}s idle (reclaiming unified RAM)`
        );
        await stopLlamaServer(context);
        if (getSettings().proxyPort) {
          await reloadProxyConfig(context, log);
        }
      }
    })();
  }, POLL_MS);
};

/** Stops the lifecycle polling interval. */
export const stopLlamaLifecycleManager = (): void => {
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
  lastStartAttemptMs = 0;
};
