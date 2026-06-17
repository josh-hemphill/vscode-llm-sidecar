import * as vscode from "vscode";
import { getSettings } from "./config/store.ts";
import { registerCommands } from "./commands/index.ts";
import { registerInlineCompletion } from "./inline/completion.ts";
import {
  hasModelAsset,
  resolveModelAsset,
} from "./llama/model-assets.ts";
import { hasLlamaServerBinary } from "./llama/server-assets.ts";
import { startLlamaServer } from "./llama/process.ts";
import { refreshModelCacheIfNeeded } from "./models/discover.ts";
import {
  buildModelCatalog,
  awaitBootstrap,
  getOutputChannel,
  getProxyBaseUrl,
  reloadProxyConfig,
  startProxy,
  stopProxy,
  trackBootstrap,
} from "./proxy/process.ts";
import { disposeOutputChannel } from "./proxy/output-channel.ts";
import { runProxyDiagnostics } from "./proxy/diagnose.ts";
import {
  isCopilotByokSecretLikelyMissing,
  openCopilotByokSetup,
} from "./secrets/byok.ts";
import { runSyncTargets } from "./sync/registry.ts";
import { refreshSidecarStatusBar } from "./status/refresh.ts";

let statusBarItem: vscode.StatusBarItem | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let missingAssetPromptShown = false;

const refreshStatusBar = (): void => {
  if (!statusBarItem || !extensionContext) {
    return;
  }
  void refreshSidecarStatusBar(extensionContext, statusBarItem);
};

const promptMissingAssets = async (
  context: vscode.ExtensionContext,
  settings: ReturnType<typeof getSettings>
): Promise<void> => {
  if (missingAssetPromptShown || !settings.autoStartLlama) {
    return;
  }

  const modelMissing = !(await hasModelAsset(
    context,
    settings.orchestrator.selectedModelId,
    {
      modelPath: settings.orchestrator.modelPath,
      modelMirrorUrl: settings.orchestrator.modelMirrorUrl,
      modelReleaseAsset: settings.orchestrator.modelReleaseAsset,
    }
  ));
  const llamaMissing = !hasLlamaServerBinary(
    context,
    settings.orchestrator.llamaServerInstallDir,
    settings.orchestrator.llamaServerBinaryPath
  );

  if (!modelMissing && !llamaMissing) {
    return;
  }

  missingAssetPromptShown = true;
  const parts: string[] = [];
  if (llamaMissing) {
    parts.push("llama-server");
  }
  if (modelMissing) {
    parts.push("bind model");
  }

  const action = await vscode.window.showWarningMessage(
    `LLM Sidecar is missing ${parts.join(" and ")}. Download now or open settings.`,
    "Download Llama Server",
    "Download Model",
    "Open Settings"
  );

  if (action === "Download Llama Server") {
    await vscode.commands.executeCommand("llmSidecar.downloadLlamaServer");
  } else if (action === "Download Model") {
    await vscode.commands.executeCommand("llmSidecar.downloadModel");
  } else if (action === "Open Settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "llmSidecar.orchestrator"
    );
  }
};

/** Starts proxy/llama after activate returns so install/activation is not blocked. */
const bootstrapSidecar = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel
): Promise<void> => {
  const settings = getSettings();

  const model = await resolveModelAsset(context, {
    modelPath: settings.orchestrator.modelPath,
    modelMirrorUrl: settings.orchestrator.modelMirrorUrl,
    modelReleaseAsset: settings.orchestrator.modelReleaseAsset,
    selectedModelId: settings.orchestrator.selectedModelId,
  });
  if (!model && settings.autoStartLlama) {
    log.appendLine(
      "Bind model not found. Run “LLM Sidecar: Download Bind Model” or set llmSidecar.orchestrator.modelPath."
    );
  }

  void promptMissingAssets(context, settings);

  if (!settings.autoStartProxy) {
    refreshStatusBar();
    return;
  }

  try {
    await refreshModelCacheIfNeeded(context, log, { secretRetries: 5 });
    await startProxy(context, log, { skipLlama: true });
    if (settings.autoStartLlama) {
      await startLlamaServer(context, log);
      if (getProxyBaseUrl()) {
        await reloadProxyConfig(context, log);
        refreshStatusBar();
      }
    }
    const base = getProxyBaseUrl();
    if (base) {
      const catalog = await buildModelCatalog(context, base);
      log.appendLine(
        `Proxy catalog: ${catalog.models.length} model(s) at ${base}`
      );
      if (catalog.models.length === 0 && settings.endpoints.length > 0) {
        log.appendLine(
          "No models in proxy catalog. Run “LLM Sidecar: Refresh Model Catalog”, set an endpoint API key, or check llmSidecar.endpoints."
        );
      }
      await reloadProxyConfig(context, log);
      refreshStatusBar();
      if (settings.autoSyncOnActivate) {
        const catalog = await buildModelCatalog(context, base);
        if (catalog.models.length > 0) {
          await runSyncTargets(context, log, base);
          if (await isCopilotByokSecretLikelyMissing()) {
            log.appendLine(
              "Copilot BYOK: chat.lm.secret for LLM Sidecar is not configured. Run “LLM Sidecar: Configure Copilot BYOK Secret” and set the key to local."
            );
          }
        } else {
          log.appendLine("Skipped auto-sync: no models in local cache or proxy");
        }
      }
    } else {
      refreshStatusBar();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.appendLine(`LLM Sidecar bootstrap failed: ${message}`);
    void vscode.window.showErrorMessage(
      `LLM Sidecar failed to start: ${message}`
    );
    refreshStatusBar();
  }
};

export const activate = async (
  context: vscode.ExtensionContext
): Promise<void> => {
  extensionContext = context;
  const log = getOutputChannel();
  context.subscriptions.push(log);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  registerCommands(context, refreshStatusBar);
  registerInlineCompletion(context);

  const settings = getSettings();
  if (settings.endpoints.length === 0) {
    log.appendLine(
      "Setup: no endpoints configured. Run “LLM Sidecar: Add First Endpoint”."
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("llmSidecar")) {
        return;
      }
      try {
        if (getProxyBaseUrl()) {
          await reloadProxyConfig(context, log);
          const base = getProxyBaseUrl();
          if (base) {
            const catalog = await buildModelCatalog(context, base);
            if (catalog.models.length > 0) {
              await runSyncTargets(context, log, base);
            }
          }
        }
        refreshStatusBar();
      } catch (err) {
        log.appendLine(`Config change handler failed: ${String(err)}`);
      }
    })
  );

  const bootstrap = bootstrapSidecar(context, log);
  trackBootstrap(bootstrap);
  void bootstrap;
};

export const deactivate = async (): Promise<void> => {
  await awaitBootstrap();
  disposeOutputChannel();
  if (extensionContext) {
    await stopProxy(extensionContext);
  }
};
