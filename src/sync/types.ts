import type * as vscode from "vscode";
import type { ModelCatalog } from "../config/schema.ts";

export interface SyncResult {
  targetId: string;
  ok: boolean;
  message: string;
}

export interface SyncTarget {
  readonly id: string;
  isAvailable(): boolean | Promise<boolean>;
  sync(
    context: vscode.ExtensionContext,
    catalog: ModelCatalog
  ): Promise<SyncResult>;
}
