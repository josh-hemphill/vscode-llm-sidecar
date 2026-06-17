import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSettings } from "../../config/store.ts";
import { resolveChatLanguageModelsPath } from "../paths.ts";
import {
  MERGE_VENDOR,
  mergeChatLanguageModelsProviders,
  type ChatLanguageModelsProvider,
} from "../merge-providers.ts";
import type { SyncResult, SyncTarget } from "../types.ts";

export const createChatLanguageModelsTarget = (
  options: Record<string, unknown>
): SyncTarget => ({
  id: "chatLanguageModels",

  isAvailable: () => true,

  sync: async (_context, catalog): Promise<SyncResult> => {
    const providerName =
      typeof options.providerName === "string"
        ? options.providerName
        : "LLM Sidecar";
    const filePath = resolveChatLanguageModelsPath();
    let existing: ChatLanguageModelsProvider[] = [];
    try {
      const raw = await fs.readFile(filePath, "utf8");
      existing = JSON.parse(raw) as ChatLanguageModelsProvider[];
      if (!Array.isArray(existing)) {
        existing = [];
      }
    } catch {
      existing = [];
    }

    const settings = getSettings();
    const merged = mergeChatLanguageModelsProviders(existing, catalog, {
      providerName,
      copilotByokSecretId: settings.copilotByokSecretId,
    });

    const tmp = `${filePath}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    await fs.rename(tmp, filePath);

    const modelCount = merged.find(
      (p) => p.name === providerName && p.vendor === MERGE_VENDOR
    )?.models.length ?? 0;

    return {
      targetId: "chatLanguageModels",
      ok: true,
      message: `Wrote ${modelCount} model(s) to ${filePath}`,
    };
  },
});
