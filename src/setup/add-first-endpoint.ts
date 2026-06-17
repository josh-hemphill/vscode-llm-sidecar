import * as vscode from "vscode";
import { getSettings } from "../config/store.ts";
import type { EndpointConfig } from "../config/schema.ts";
import {
  ENDPOINT_TEMPLATE_CHOICES,
  uniqueEndpointId,
  type EndpointTemplateId,
} from "./endpoint-templates.ts";

const isValidUpstreamUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const pickTemplate = async (): Promise<EndpointTemplateId | undefined> => {
  const picked = await vscode.window.showQuickPick(
    ENDPOINT_TEMPLATE_CHOICES.map((t) => ({
      label: t.label,
      description: t.description,
      templateId: t.id,
    })),
    {
      title: "Add upstream endpoint",
      placeHolder: "Choose a template for your first endpoint",
    }
  );
  return picked?.templateId;
};

const buildEndpointFromTemplate = async (
  templateId: EndpointTemplateId
): Promise<EndpointConfig | undefined> => {
  const template = ENDPOINT_TEMPLATE_CHOICES.find((t) => t.id === templateId);
  if (!template) {
    return undefined;
  }
  if (templateId === "custom") {
    const url = await vscode.window.showInputBox({
      title: "Custom upstream URL",
      prompt: "Chat completions URL (e.g. https://api.example.com/v1/chat/completions)",
      placeHolder: "https://",
      ignoreFocusOut: true,
      validateInput: (v) =>
        isValidUpstreamUrl(v) ? undefined : "Enter a valid http(s) URL",
    });
    if (!url) {
      return undefined;
    }
    return template.build(url);
  }
  return template.build();
};

/** Adds an endpoint from a built-in template and opens settings for review. */
export const runAddFirstEndpoint = async (
  _context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  options?: { promptForApiKey?: boolean }
): Promise<boolean> => {
  const templateId = await pickTemplate();
  if (!templateId) {
    return false;
  }

  const built = await buildEndpointFromTemplate(templateId);
  if (!built?.upstreamUrl.trim()) {
    return false;
  }

  const settings = getSettings();
  const id = uniqueEndpointId(built.id, settings.endpoints);
  const endpoint: EndpointConfig = { ...built, id };

  const endpoints = [...settings.endpoints, endpoint];
  await vscode.workspace
    .getConfiguration("llmSidecar")
    .update("endpoints", endpoints, vscode.ConfigurationTarget.Global);

  log.appendLine(
    `Added endpoint "${endpoint.displayName ?? endpoint.id}" (${endpoint.upstreamUrl})`
  );

  const pick = await vscode.window.showInformationMessage(
    `LLM Sidecar: added endpoint "${endpoint.displayName ?? endpoint.id}". Set your upstream API key next.`,
    "Set API Key",
    "Open Settings",
    "Later"
  );
  if (pick === "Set API Key" || options?.promptForApiKey) {
    await vscode.commands.executeCommand("llmSidecar.setEndpointApiKey");
  } else if (pick === "Open Settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:jo-hemphill.llm-sidecar"
    );
  }

  return true;
};

export const WALKTHROUGH_ID = "jo-hemphill.llm-sidecar#gettingStarted";

/** Opens the built-in Getting Started walkthrough. */
export const openGettingStartedWalkthrough = async (): Promise<void> => {
  await vscode.commands.executeCommand(
    "workbench.action.openWalkthrough",
    WALKTHROUGH_ID
  );
};
