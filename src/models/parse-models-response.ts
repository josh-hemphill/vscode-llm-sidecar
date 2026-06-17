import type { DiscoveredModelRow } from "../config/schema.ts";

/** Parses OpenAI-style or bare-array upstream model list responses. */
export const parseModelsResponse = (body: unknown): DiscoveredModelRow[] => {
  if (Array.isArray(body)) {
    return body
      .filter((row): row is { id: string } => typeof row?.id === "string")
      .map((row) => {
        const named = row as { id: string; name?: string };
        return {
          id: named.id,
          name: typeof named.name === "string" ? named.name : undefined,
        };
      });
  }
  if (body && typeof body === "object" && "data" in body) {
    const data = (body as { data: unknown }).data;
    if (Array.isArray(data)) {
      return parseModelsResponse(data);
    }
  }
  return [];
};
