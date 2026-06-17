import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MERGE_VENDOR,
  mergeChatLanguageModelsProviders,
  type ChatLanguageModelsProvider,
} from "./merge-providers.ts";
import type { ModelCatalog } from "../config/schema.ts";

const catalog = (): ModelCatalog => ({
  proxyBaseUrl: "http://127.0.0.1:3847",
  models: [
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      endpointId: "gemini",
      toolCalling: true,
      vision: false,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 8192,
      thinking: false,
      streaming: true,
      apiType: "chat-completions",
      extras: {},
    },
  ],
});

describe("mergeChatLanguageModelsProviders", () => {
  it("preserves unrelated providers", () => {
    const existing: ChatLanguageModelsProvider[] = [
      {
        name: "Other",
        vendor: "other-vendor",
        apiType: "chat-completions",
        models: [{ id: "x" }],
      },
    ];
    const merged = mergeChatLanguageModelsProviders(existing, catalog(), {
      providerName: "LLM Sidecar",
    });
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.vendor, "other-vendor");
  });

  it("replaces only matching vendor and provider name", () => {
    const existing: ChatLanguageModelsProvider[] = [
      {
        name: "LLM Sidecar",
        vendor: MERGE_VENDOR,
        apiType: "chat-completions",
        models: [{ id: "old-model" }],
      },
      {
        name: "Other Normalizer",
        vendor: MERGE_VENDOR,
        apiType: "chat-completions",
        models: [{ id: "keep-me" }],
      },
    ];
    const merged = mergeChatLanguageModelsProviders(existing, catalog(), {
      providerName: "LLM Sidecar",
    });
    const ours = merged.find((p) => p.name === "LLM Sidecar");
    const other = merged.find((p) => p.name === "Other Normalizer");
    assert.equal(ours?.models[0]?.id, "gemini-2.5-pro");
    assert.equal(other?.models[0]?.id, "keep-me");
  });

  it("sets model url to proxy v1 base for Copilot path resolution", () => {
    const merged = mergeChatLanguageModelsProviders([], catalog());
    const model = merged[0]?.models[0] as { url?: string };
    assert.equal(model.url, "http://127.0.0.1:3847/v1");
  });

  it("does not replace existing models when catalog is empty", () => {
    const existing: ChatLanguageModelsProvider[] = [
      {
        name: "LLM Sidecar",
        vendor: MERGE_VENDOR,
        apiType: "chat-completions",
        models: [{ id: "gemini-2.5-pro" }, { id: "gpt-4o" }],
      },
    ];
    const empty: ModelCatalog = {
      proxyBaseUrl: "http://127.0.0.1:3847",
      models: [],
    };
    const merged = mergeChatLanguageModelsProviders(existing, empty, {
      providerName: "LLM Sidecar",
    });
    assert.equal(merged, existing);
    assert.equal(merged[0]?.models.length, 2);
  });

  it("uses secret placeholder not a raw api key", () => {
    const merged = mergeChatLanguageModelsProviders([], catalog(), {
      copilotByokSecretId: "mySecret",
    });
    assert.equal(merged[0]?.apiKey, "${input:chat.lm.secret.mySecret}");
    assert.ok(!merged[0]?.apiKey?.includes("sk-"));
  });

  it("passes model extras through to synced output", () => {
    const withExtras: ModelCatalog = {
      proxyBaseUrl: "http://127.0.0.1:3847",
      models: [
        {
          id: "gpt-4.1",
          name: "GPT 4.1",
          endpointId: "corp",
          toolCalling: false,
          vision: false,
          maxInputTokens: 128000,
          maxOutputTokens: 8192,
          thinking: true,
          streaming: false,
          apiType: "chat-completions",
          extras: { family: "gpt", temperature: 0.2 },
        },
      ],
    };
    const merged = mergeChatLanguageModelsProviders([], withExtras);
    const model = merged[0].models[0] as Record<string, unknown>;
    assert.equal(model.thinking, true);
    assert.equal(model.family, "gpt");
    assert.equal(model.temperature, 0.2);
  });
});
