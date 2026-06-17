import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { AuditLogEntry } from "../config/schema.ts";

const AUDIT_FILE = "audit-log.jsonl";
const MAX_ENTRIES = 500;

const auditFilePath = (context: vscode.ExtensionContext): string =>
  path.join(context.globalStorageUri.fsPath, AUDIT_FILE);

/** Appends an audit entry to the local JSONL log. */
export const appendAuditEntry = async (
  context: vscode.ExtensionContext,
  entry: AuditLogEntry
): Promise<void> => {
  const filePath = auditFilePath(context);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  await trimAuditLog(filePath);
};

const trimAuditLog = async (filePath: string): Promise<void> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length <= MAX_ENTRIES) {
      return;
    }
    const trimmed = lines.slice(lines.length - MAX_ENTRIES);
    await fs.writeFile(filePath, `${trimmed.join("\n")}\n`, "utf8");
  } catch {
    // ignore trim failures
  }
};

/** Reads recent audit entries for the inspector command. */
export const readAuditEntries = async (
  context: vscode.ExtensionContext,
  limit = 50
): Promise<AuditLogEntry[]> => {
  try {
    const raw = await fs.readFile(auditFilePath(context), "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditLogEntry);
  } catch {
    return [];
  }
};

/** Opens the audit log in an editor tab. */
export const showAuditLog = async (
  context: vscode.ExtensionContext
): Promise<void> => {
  const entries = await readAuditEntries(context, 200);
  const doc = await vscode.workspace.openTextDocument({
    content: entries.map((e) => JSON.stringify(e, null, 2)).join("\n\n"),
    language: "json",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
};
