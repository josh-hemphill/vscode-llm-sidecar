import type * as vscode from "vscode";
import {
  clearProxyOwnerFromDir,
  readProxyOwnerFromDir,
  writeProxyOwnerToDir,
} from "./proxy-owner-fs.ts";

export type { ProxyOwnerRecord } from "./proxy-owner-fs.ts";
export {
  clearProxyOwnerFromDir,
  proxyOwnerPath,
  readProxyOwnerFromDir,
  writeProxyOwnerToDir,
} from "./proxy-owner-fs.ts";

const resolveOwnerBaseDir = (
  context: vscode.ExtensionContext,
  baseDir?: string
): string => baseDir ?? context.globalStorageUri.fsPath;

export const readProxyOwner = async (
  context: vscode.ExtensionContext,
  baseDir?: string
): Promise<import("./proxy-owner-fs.ts").ProxyOwnerRecord | undefined> =>
  readProxyOwnerFromDir(resolveOwnerBaseDir(context, baseDir));

export const writeProxyOwner = async (
  context: vscode.ExtensionContext,
  pid: number,
  port: number,
  baseDir?: string
): Promise<void> =>
  writeProxyOwnerToDir(resolveOwnerBaseDir(context, baseDir), pid, port);

export const clearProxyOwner = async (
  context: vscode.ExtensionContext,
  baseDir?: string
): Promise<void> => clearProxyOwnerFromDir(resolveOwnerBaseDir(context, baseDir));
