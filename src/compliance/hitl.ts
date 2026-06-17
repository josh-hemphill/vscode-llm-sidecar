import * as vscode from "vscode";
import { getSettings } from "../config/store.ts";
import {
  buildToolEligibilityDenyAll,
  HITL_SETTING_KEYS,
} from "./hitl-policy.ts";

const hitlTargets = (): vscode.ConfigurationTarget[] => {
  const targets = [vscode.ConfigurationTarget.Global];
  if (vscode.workspace.workspaceFolders?.length) {
    targets.push(vscode.ConfigurationTarget.Workspace);
  }
  return targets;
};

/** Applies Human-in-the-Loop enforcement settings in global and workspace scope. */
export const enforceHumanInTheLoopSettings = async (
  extraToolNames: string[] = []
): Promise<void> => {
  const chatCfg = vscode.workspace.getConfiguration("chat.tools");
  const existing =
    chatCfg.get<Record<string, boolean>>(
      HITL_SETTING_KEYS.eligibleForAutoApproval.replace("chat.tools.", "")
    ) ?? {};
  const denyAll = buildToolEligibilityDenyAll([
    ...Object.keys(existing),
    ...extraToolNames,
  ]);
  for (const target of hitlTargets()) {
    await chatCfg.update(
      HITL_SETTING_KEYS.globalAutoApprove.replace("chat.tools.", ""),
      false,
      target
    );
    await chatCfg.update(
      HITL_SETTING_KEYS.terminalEnableAutoApprove.replace("chat.tools.", ""),
      false,
      target
    );
    await chatCfg.update(
      HITL_SETTING_KEYS.terminalAutoApprove.replace("chat.tools.", ""),
      { "*": false },
      target
    );
    await chatCfg.update(
      HITL_SETTING_KEYS.eligibleForAutoApproval.replace("chat.tools.", ""),
      denyAll,
      target
    );
  }
};

/** Returns whether HITL enforcement is active and settings look safe. */
export const isHumanInTheLoopEnforced = (): boolean => {
  if (!getSettings().enforceHumanInTheLoop) {
    return false;
  }
  const chatCfg = vscode.workspace.getConfiguration("chat.tools");
  const globalAuto = chatCfg.get<boolean>(
    HITL_SETTING_KEYS.globalAutoApprove.replace("chat.tools.", ""),
    false
  );
  const terminalEnabled = chatCfg.get<boolean>(
    HITL_SETTING_KEYS.terminalEnableAutoApprove.replace("chat.tools.", ""),
    true
  );
  const terminalAutoApprove = chatCfg.get<Record<string, boolean>>(
    HITL_SETTING_KEYS.terminalAutoApprove.replace("chat.tools.", ""),
    {}
  );
  const eligible = chatCfg.get<Record<string, boolean>>(
    HITL_SETTING_KEYS.eligibleForAutoApproval.replace("chat.tools.", ""),
    {}
  );
  const terminalWildcard = terminalAutoApprove["*"] ?? false;
  const anyToolEligible = Object.values(eligible).some((v) => v === true);
  return !globalAuto && !terminalEnabled && !terminalWildcard && !anyToolEligible;
};

/** Starts HITL enforcement on activate and re-applies when chat tool settings change. */
export const registerHumanInTheLoopWatcher = (
  context: vscode.ExtensionContext
): void => {
  const apply = async (): Promise<void> => {
    if (!getSettings().enforceHumanInTheLoop) {
      return;
    }
    await enforceHumanInTheLoopSettings();
  };

  void apply();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(HITL_SETTING_KEYS.globalAutoApprove) ||
        e.affectsConfiguration(HITL_SETTING_KEYS.terminalEnableAutoApprove) ||
        e.affectsConfiguration(HITL_SETTING_KEYS.terminalAutoApprove) ||
        e.affectsConfiguration(HITL_SETTING_KEYS.eligibleForAutoApproval) ||
        e.affectsConfiguration("llmSidecar.enforceHumanInTheLoop")
      ) {
        void apply();
      }
    })
  );
};

/** Toggles HITL enforcement via settings. */
export const toggleHumanInTheLoop = async (): Promise<boolean> => {
  const cfg = vscode.workspace.getConfiguration("llmSidecar");
  const current = cfg.get<boolean>("enforceHumanInTheLoop", true);
  const next = !current;
  await cfg.update("enforceHumanInTheLoop", next, vscode.ConfigurationTarget.Global);
  if (next) {
    await enforceHumanInTheLoopSettings();
  }
  return next;
};
