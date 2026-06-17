import * as vscode from "vscode";
import type { EndpointConfig } from "../config/schema.ts";
import { getSettings } from "../config/store.ts";
import { resolveEndpointSecretId } from "./keys.ts";

export const pickEndpoint = async (
  endpoints: EndpointConfig[]
): Promise<EndpointConfig | undefined> => {
  if (endpoints.length === 0) {
    void vscode.window.showWarningMessage(
      "Configure llmSidecar.endpoints before setting an API key."
    );
    return undefined;
  }
  if (endpoints.length === 1) {
    return endpoints[0];
  }
  const picked = await vscode.window.showQuickPick(
    endpoints.map((ep) => ({
      label: ep.displayName ?? ep.id,
      description: ep.upstreamUrl,
      endpoint: ep,
    })),
    { title: "Select endpoint" }
  );
  return picked?.endpoint;
};

export const promptAndStoreEndpointApiKey = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  endpoint?: EndpointConfig
): Promise<boolean> => {
  const settings = getSettings();
  const ep = endpoint ?? (await pickEndpoint(settings.endpoints));
  if (!ep) {
    return false;
  }

  const secretId = resolveEndpointSecretId(ep);
  const value = await vscode.window.showInputBox({
    title: `API key for ${ep.displayName ?? ep.id}`,
    prompt: `Stored securely as ${secretId}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return false;
  }
  if (!value.trim()) {
    void vscode.window.showWarningMessage("API key was empty; not stored.");
    return false;
  }

  await context.secrets.store(secretId, value.trim());
  log.appendLine(
    `Stored upstream API key for endpoint "${ep.id}" (secret: ${secretId})`
  );

  if (!ep.apiKeySecretId?.trim()) {
    const endpoints = settings.endpoints.map((item) =>
      item.id === ep.id
        ? { ...item, apiKeySecretId: secretId }
        : item
    );
    await vscode.workspace
      .getConfiguration("llmSidecar")
      .update("endpoints", endpoints, vscode.ConfigurationTarget.Global);
  }

  void vscode.window.showInformationMessage(
    `LLM Sidecar: API key saved for "${ep.displayName ?? ep.id}". Run Refresh Model Catalog.`
  );
  return true;
};

export const clearEndpointApiKey = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  endpoint?: EndpointConfig
): Promise<boolean> => {
  const settings = getSettings();
  const ep = endpoint ?? (await pickEndpoint(settings.endpoints));
  if (!ep) {
    return false;
  }
  const secretId = resolveEndpointSecretId(ep);
  await context.secrets.delete(secretId);
  log.appendLine(`Cleared upstream API key for endpoint "${ep.id}" (${secretId})`);
  void vscode.window.showInformationMessage(
    `LLM Sidecar: API key cleared for "${ep.displayName ?? ep.id}".`
  );
  return true;
};

/** Read upstream API key; retries help when SecretStorage is slow on first activation. */
export const getEndpointApiKey = async (
  context: vscode.ExtensionContext,
  endpoint: EndpointConfig,
  options?: { retries?: number; retryDelayMs?: number }
): Promise<string | undefined> => {
  const secretId = resolveEndpointSecretId(endpoint);
  const attempts = Math.max(1, options?.retries ?? 1);
  const delayMs = options?.retryDelayMs ?? 150;
  for (let i = 0; i < attempts; i += 1) {
    const value = await context.secrets.get(secretId);
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return undefined;
};

/** Endpoints that need an upstream key for discovery but have none stored. */
export const endpointsMissingApiKey = async (
  context: vscode.ExtensionContext,
  endpoints: EndpointConfig[],
  isEnabled: (ep: EndpointConfig) => boolean
): Promise<EndpointConfig[]> => {
  const missing: EndpointConfig[] = [];
  for (const ep of endpoints) {
    if (!isEnabled(ep)) {
      continue;
    }
    const key = await getEndpointApiKey(context, ep);
    if (!key) {
      missing.push(ep);
    }
  }
  return missing;
};

