import type { ModelCatalog, ModelCatalogEntry } from "../config/schema.ts";

interface ProxyModelsResponse {
  data?: Array<{ id?: string; owned_by?: string }>;
}

const entryFromProxyRow = (
  id: string,
  endpointId: string
): ModelCatalogEntry => ({
  id,
  name: id,
  endpointId,
  toolCalling: true,
  vision: false,
  maxInputTokens: 128_000,
  maxOutputTokens: 8_192,
  thinking: false,
  streaming: true,
  apiType: "chat-completions",
  extras: {},
});

/** Lists model ids currently served by the local proxy (GET /v1/models). */
export const fetchModelCatalogFromProxy = async (
  baseUrl: string
): Promise<ModelCatalog> => {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`);
    if (!res.ok) {
      return { proxyBaseUrl: baseUrl, models: [] };
    }
    const body = (await res.json()) as ProxyModelsResponse;
    const rows = body.data ?? [];
    const models: ModelCatalogEntry[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id) {
        continue;
      }
      models.push(
        entryFromProxyRow(row.id, typeof row.owned_by === "string" ? row.owned_by : "unknown")
      );
    }
    return { proxyBaseUrl: baseUrl, models };
  } catch {
    return { proxyBaseUrl: baseUrl, models: [] };
  }
};

export const countPayloadModels = (
  payload: { endpoints: Array<{ models?: unknown[] }> }
): number =>
  payload.endpoints.reduce(
    (n, ep) => n + (Array.isArray(ep.models) ? ep.models.length : 0),
    0
  );
