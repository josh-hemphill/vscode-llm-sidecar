import type * as vscode from "vscode";
import { getSettings } from "../config/store.ts";
import { buildModelCatalog } from "../proxy/process.ts";
import { createChatLanguageModelsTarget } from "./targets/chat-language-models.ts";
import type { SyncResult, SyncTarget } from "./types.ts";

const targetFactories: Record<
  string,
  (options: Record<string, unknown>) => SyncTarget
> = {
  chatLanguageModels: createChatLanguageModelsTarget,
};

export const runSyncTargets = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  baseUrl: string
): Promise<SyncResult[]> => {
  const settings = getSettings();
  const catalog = await buildModelCatalog(context, baseUrl);
  const enabled = settings.syncTargets.filter((t) => t.enabled);
  const results: SyncResult[] = [];

  await Promise.all(
    enabled.map(async (cfg) => {
      const factory = targetFactories[cfg.id];
      if (!factory) {
        results.push({
          targetId: cfg.id,
          ok: false,
          message: `Unknown sync target: ${cfg.id}`,
        });
        return;
      }
      const target = factory(cfg.options ?? {});
      const available = await target.isAvailable();
      if (!available) {
        results.push({
          targetId: cfg.id,
          ok: false,
          message: "Target not available",
        });
        return;
      }
      try {
        const result = await target.sync(context, catalog);
        results.push(result);
        log.appendLine(
          `[sync:${result.targetId}] ${result.ok ? "ok" : "fail"}: ${result.message}`
        );
      } catch (err) {
        results.push({
          targetId: cfg.id,
          ok: false,
          message: String(err),
        });
      }
    })
  );

  return results;
};
