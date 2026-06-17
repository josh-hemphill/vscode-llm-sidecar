import * as vscode from "vscode";
import { getSettings, loadMergedProfiles } from "../config/store.ts";
import { showAuditLog } from "../compliance/audit.ts";
import {
  registerHumanInTheLoopWatcher,
  toggleHumanInTheLoop,
} from "../compliance/hitl.ts";
import {
  downloadOrchestratorModel,
  formatModelSizeGb,
  listOrchestratorModels,
} from "../llama/model-assets.ts";
import { downloadLlamaServer, hasLlamaServerBinary } from "../llama/server-assets.ts";
import {
  getOutputChannel,
  getProxyBaseUrl,
  reloadProxyConfig,
  startProxy,
  stopProxy,
} from "../proxy/process.ts";
import { refreshModelCache } from "../models/discover.ts";
import { runSyncTargets } from "../sync/registry.ts";
import { runProxyDiagnostics } from "../proxy/diagnose.ts";
import { openCopilotByokSetup } from "../secrets/byok.ts";
import {
  clearEndpointApiKey,
  promptAndStoreEndpointApiKey,
} from "../secrets/prompt.ts";
import {
  openGettingStartedWalkthrough,
  runAddFirstEndpoint,
} from "../setup/add-first-endpoint.ts";

export const registerCommands = (
  context: vscode.ExtensionContext,
  refreshStatusBar: () => void
): void => {
  const log = getOutputChannel();
  registerHumanInTheLoopWatcher(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("llmSidecar.startProxy", async () => {
      await startProxy(context, log);
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("llmSidecar.stopProxy", async () => {
      await stopProxy(context);
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("llmSidecar.reloadProxy", async () => {
      const ok = await reloadProxyConfig(context, log);
      if (!ok) {
        await startProxy(context, log);
      }
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("llmSidecar.syncLanguageModels", async () => {
      const base = getProxyBaseUrl();
      if (!base) {
        const handle = await startProxy(context, log);
        if (!handle) {
          return;
        }
      }
      const results = await runSyncTargets(
        context,
        log,
        getProxyBaseUrl()!
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        void vscode.window.showWarningMessage(
          `LLM Sidecar sync: ${failed.map((f) => f.targetId).join(", ")} failed`
        );
      } else {
        void vscode.window.showInformationMessage(
          "LLM Sidecar: language models synced."
        );
      }
    }),
    vscode.commands.registerCommand("llmSidecar.downloadModel", async () => {
      const settings = getSettings();
      const catalog = listOrchestratorModels(context.extensionPath);
      const pick = await vscode.window.showQuickPick(
        catalog.map((entry) => ({
          label: entry.displayName,
          description: `${formatModelSizeGb(entry.sizeBytes)} · ${entry.license}`,
          detail: entry.id,
          entry,
        })),
        {
          title: "Download bind model (US-compliant catalog)",
          placeHolder: settings.orchestrator.selectedModelId,
        }
      );
      if (!pick) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${pick.entry.displayName}`,
          cancellable: false,
        },
        async (progress) => {
          let lastPct = 0;
          await downloadOrchestratorModel(
            context,
            log,
            {
              modelId: pick.entry.id,
              modelMirrorUrl: settings.orchestrator.modelMirrorUrl,
              modelMirrorSha256: settings.orchestrator.modelMirrorSha256,
              modelReleaseAsset: settings.orchestrator.modelReleaseAsset,
              expectedSha256: pick.entry.sources[0]?.sha256,
            },
            (pct) => {
              const delta = pct - lastPct;
              lastPct = pct;
              progress.report({ increment: delta, message: `${pct}%` });
            }
          );
        }
      );
      const cfg = vscode.workspace.getConfiguration("llmSidecar");
      const storedOrchestrator = cfg.get<Record<string, unknown>>("orchestrator", {});
      await cfg.update(
        "orchestrator",
        { ...storedOrchestrator, selectedModelId: pick.entry.id },
        vscode.ConfigurationTarget.Global
      );
      await startProxy(context, log, { skipDiscovery: true });
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("llmSidecar.downloadLlamaServer", async () => {
      const settings = getSettings();
      const bundleOk = hasLlamaServerBinary(
        context,
        settings.orchestrator.llamaServerInstallDir,
        settings.orchestrator.llamaServerBinaryPath
      );
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Downloading llama-server",
          cancellable: false,
        },
        async (progress) => {
          let lastPct = 0;
          await downloadLlamaServer(
            context,
            log,
            {
              variant: settings.orchestrator.llamaServerVariant,
              installDirSetting: settings.orchestrator.llamaServerInstallDir,
              force: !bundleOk,
            },
            (pct) => {
              const delta = pct - lastPct;
              lastPct = pct;
              progress.report({ increment: delta, message: `${pct}%` });
            }
          );
        }
      );
      await startProxy(context, log, { skipDiscovery: true });
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("llmSidecar.toggleHitl", async () => {
      const enabled = await toggleHumanInTheLoop();
      void vscode.window.showInformationMessage(
        enabled
          ? "LLM Sidecar: Human-in-the-Loop enforcement enabled."
          : "LLM Sidecar: Human-in-the-Loop enforcement disabled."
      );
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("llmSidecar.viewAuditLog", async () => {
      await showAuditLog(context);
    }),
    vscode.commands.registerCommand("llmSidecar.exportProfile", async () => {
      const settings = getSettings();
      const profiles = await loadMergedProfiles(settings);
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ["json"] },
        defaultUri: vscode.Uri.file("llm-sidecar-profiles.json"),
      });
      if (!uri) {
        return;
      }
      const fs = await import("node:fs/promises");
      await fs.writeFile(
        uri.fsPath,
        `${JSON.stringify(profiles, null, 2)}\n`,
        "utf8"
      );
      void vscode.window.showInformationMessage(
        `Exported profiles to ${uri.fsPath}`
      );
    }),
    vscode.commands.registerCommand("llmSidecar.addFirstEndpoint", async () => {
      const added = await runAddFirstEndpoint(context, log);
      if (added) {
        await reloadProxyConfig(context, log);
        refreshStatusBar();
      }
    }),
    vscode.commands.registerCommand(
      "llmSidecar.openGettingStarted",
      async () => {
        await openGettingStartedWalkthrough();
      }
    ),
    vscode.commands.registerCommand("llmSidecar.setEndpointApiKey", async () => {
      const stored = await promptAndStoreEndpointApiKey(context, log);
      if (stored) {
        await reloadProxyConfig(context, log);
        refreshStatusBar();
      }
    }),
    vscode.commands.registerCommand("llmSidecar.clearEndpointApiKey", async () => {
      const cleared = await clearEndpointApiKey(context, log);
      if (cleared) {
        await reloadProxyConfig(context, log);
        refreshStatusBar();
      }
    }),
    vscode.commands.registerCommand("llmSidecar.refreshModels", async () => {
      const { results } = await refreshModelCache(context, log, { force: true });
      const ok = await reloadProxyConfig(context, log);
      if (!ok) {
        await stopProxy(context);
        await startProxy(context, log, { skipDiscovery: true });
      }
      const base = getProxyBaseUrl();
      if (base) {
        await runSyncTargets(context, log, base);
      }
      const failed = results.filter((r) => !r.ok);
      const total = results.reduce((n, r) => n + r.modelCount, 0);
      if (failed.length > 0) {
        void vscode.window.showWarningMessage(
          `LLM Sidecar: catalog refreshed (${total} models); ${failed.length} endpoint(s) had errors.`
        );
      } else {
        void vscode.window.showInformationMessage(
          `LLM Sidecar: discovered ${total} model(s) and synced.`
        );
      }
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("llmSidecar.configureCopilotSecret", async () => {
      await openCopilotByokSetup(log);
    }),
    vscode.commands.registerCommand("llmSidecar.testProxyChat", async () => {
      let base = getProxyBaseUrl();
      if (!base) {
        const handle = await startProxy(context, log);
        base = handle?.baseUrl;
      }
      if (!base) {
        void vscode.window.showErrorMessage(
          "LLM Sidecar: proxy is not running. See the LLM Sidecar output channel."
        );
        return;
      }
      const { resolveModelsForContext } = await import("../config/store.ts");
      const resolved = await resolveModelsForContext(context);
      const modelId = resolved[0]?.id;
      if (!modelId) {
        void vscode.window.showWarningMessage(
          "No models configured. Add an endpoint and run Refresh Model Catalog."
        );
        return;
      }
      const results = await runProxyDiagnostics(context, log, base, modelId);
      const failed = results.find((r) => !r.ok);
      if (failed) {
        void vscode.window.showErrorMessage(
          `Proxy test failed (HTTP ${failed.status}). See LLM Sidecar output channel.`
        );
      } else {
        void vscode.window.showInformationMessage(
          "Proxy chat test succeeded. See LLM Sidecar output channel for details."
        );
      }
    }),
    vscode.commands.registerCommand("llmSidecar.setInlineChatModel", async () => {
      const { resolveModelsForContext } = await import("../config/store.ts");
      const resolved = await resolveModelsForContext(context);
      const ids = resolved.map((m) => m.id);
      if (ids.length === 0) {
        void vscode.window.showWarningMessage(
          "Configure llmSidecar.endpoints with at least one model first."
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(ids, {
        title: "Default model for inline chat (inlineChat.defaultModel)",
      });
      if (!pick) {
        return;
      }
      await vscode.workspace
        .getConfiguration("inlineChat")
        .update("defaultModel", pick, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        `inlineChat.defaultModel set to ${pick}`
      );
    })
  );
};
