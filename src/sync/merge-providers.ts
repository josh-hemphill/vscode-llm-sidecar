import type { ModelCatalog } from "../config/schema.ts";
import { buildCopilotByokSecretPlaceholder } from "../secrets/keys.ts";

export interface ChatLanguageModelsProvider {
  name: string;
  vendor: string;
  apiType: string;
  apiKey?: string;
  models: Array<Record<string, unknown>>;
}

export const MERGE_VENDOR = "customendpoint";

export interface MergeProvidersOptions {
  providerName?: string;
  copilotByokSecretId?: string;
}

/** Merges catalog into provider list; replaces only our vendor+name block. */
export const mergeChatLanguageModelsProviders = (
  existing: ChatLanguageModelsProvider[],
  catalog: ModelCatalog,
  options: MergeProvidersOptions = {}
): ChatLanguageModelsProvider[] => {
  const providerName = options.providerName ?? "LLM Sidecar";
  const secretId = options.copilotByokSecretId ?? "llmSidecar";

  const existingOurs = existing.find(
    (p) => p.vendor === MERGE_VENDOR && p.name === providerName
  );
  const existingModelCount = existingOurs?.models.length ?? 0;
  if (catalog.models.length === 0 && existingModelCount > 0) {
    return existing;
  }

  const normalizedModels = catalog.models.map((m) => ({
    ...(m.extras ?? {}),
    id: m.id,
    name: m.name,
    url: `${catalog.proxyBaseUrl}/v1`,
    apiType: m.apiType ?? "chat-completions",
    toolCalling: m.toolCalling,
    vision: m.vision,
    streaming: m.streaming,
    thinking: m.thinking,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
  }));

  const ourProvider: ChatLanguageModelsProvider = {
    name: providerName,
    vendor: MERGE_VENDOR,
    apiType: "chat-completions",
    apiKey: buildCopilotByokSecretPlaceholder(secretId),
    models: normalizedModels,
  };

  const filtered = existing.filter(
    (p) => !(p.vendor === MERGE_VENDOR && p.name === providerName)
  );
  filtered.push(ourProvider);
  return filtered;
};
