import * as vscode from "vscode";
import type { DiagnosticHint, WorkspaceContextPayload } from "../config/schema.ts";

const MAX_RECENT = 20;

/** Collects workspace context for the orchestrator reason phase. */
export const gatherWorkspaceContext = async (): Promise<WorkspaceContextPayload> => {
  const roots =
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const openFiles = vscode.window.visibleTextEditors
    .map((e) => vscode.workspace.asRelativePath(e.document.uri))
    .filter((p) => p && !p.startsWith(".."));
  const recentFiles = [...openFiles];
  const diagnostics: DiagnosticHint[] = [];

  for (const root of vscode.workspace.workspaceFolders ?? []) {
    const all = vscode.languages.getDiagnostics();
    for (const [uri, diags] of all) {
      if (!uri.fsPath.startsWith(root.uri.fsPath)) {
        continue;
      }
      for (const d of diags.slice(0, 20)) {
        diagnostics.push({
          file: vscode.workspace.asRelativePath(uri),
          line: (d.range?.start.line ?? 0) + 1,
          message: d.message,
          severity: vscode.DiagnosticSeverity[d.severity] ?? "unknown",
        });
      }
    }
  }

  return {
    roots,
    openFiles: openFiles.slice(0, MAX_RECENT),
    recentFiles: recentFiles.slice(0, MAX_RECENT),
    diagnostics: diagnostics.slice(0, 50),
  };
};
