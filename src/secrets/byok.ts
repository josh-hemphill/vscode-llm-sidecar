import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { getSettings } from "../config/store.ts";
import { buildCopilotByokSecretPlaceholder } from "./keys.ts";
import { MERGE_VENDOR } from "../sync/merge-providers.ts";
import { resolveChatLanguageModelsPath } from "../sync/paths.ts";

const UNRESOLVED_SECRET = /\$\{input:chat\.lm\.secret\.[^}]+\}/;

/** True when chatLanguageModels.json still has an unresolved BYOK secret placeholder. */
export const isCopilotByokSecretLikelyMissing = async (): Promise<boolean> => {
  const settings = getSettings();
  const placeholder = buildCopilotByokSecretPlaceholder(
    settings.copilotByokSecretId
  );
  try {
    const raw = await fs.readFile(resolveChatLanguageModelsPath(), "utf8");
    const providers = JSON.parse(raw) as Array<{
      vendor?: string;
      name?: string;
      apiKey?: string;
    }>;
    if (!Array.isArray(providers)) {
      return true;
    }
    const ours = providers.find(
      (p) =>
        p.vendor === MERGE_VENDOR &&
        (p.name === "LLM Sidecar" || p.name?.includes("Sidecar"))
    );
    if (!ours) {
      return true;
    }
    const key = ours.apiKey ?? "";
    if (!key || key === placeholder) {
      return true;
    }
    return UNRESOLVED_SECRET.test(key);
  } catch {
    return true;
  }
};

/** Opens VS Code UI to set the Copilot BYOK secret for the synced provider group. */
export const openCopilotByokSetup = async (
  log: vscode.OutputChannel
): Promise<void> => {
  log.appendLine(
    "Copilot BYOK: open Chat: Manage Language Models, find the LLM Sidecar group, choose Update API Key, and enter local (any non-empty placeholder)."
  );
  try {
    await vscode.commands.executeCommand(
      "workbench.action.chat.manageLanguageModels"
    );
  } catch {
    void vscode.window.showInformationMessage(
      "Run Command Palette → Chat: Manage Language Models → LLM Sidecar → Update API Key. Use local as the key for the on-device proxy."
    );
  }
};
