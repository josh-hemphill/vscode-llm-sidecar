import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProxyConfigPayload } from "../config/schema.ts";

const PROXY_CONFIG_FILENAME = "proxy-config.json";

/** Path where the extension writes proxy config for the Rust child process. */
export const getProxyConfigPath = (
  context: vscode.ExtensionContext
): string => path.join(context.globalStorageUri.fsPath, PROXY_CONFIG_FILENAME);

/** Strips API keys from a proxy payload before persisting to disk. */
export const redactProxyPayload = (
  payload: ProxyConfigPayload
): ProxyConfigPayload => ({
  ...payload,
  endpoints: payload.endpoints.map(({ apiKey: _key, ...ep }) => ep),
});

/** Writes redacted payload to disk; returns path and byte size for logging. */
export const writeProxyConfigFile = async (
  context: vscode.ExtensionContext,
  payload: ProxyConfigPayload
): Promise<{ path: string; bytes: number }> => {
  const dir = context.globalStorageUri.fsPath;
  await fs.mkdir(dir, { recursive: true });
  const filePath = getProxyConfigPath(context);
  const redacted = redactProxyPayload(payload);
  const text = JSON.stringify(redacted);
  await fs.writeFile(filePath, text, "utf8");
  return { path: filePath, bytes: Buffer.byteLength(text, "utf8") };
};
