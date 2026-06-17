/** Canonical configuration types for LLM Sidecar. */

export interface ToolFormatProfile {
  toolCallOpen?: string;
  toolCallClose?: string;
  toolResultOpen?: string;
  toolResultClose?: string;
  argumentFormat?: string;
  allowNativeTools?: boolean;
  nameAttribute?: string;
  idAttribute?: string;
}

export interface CapabilityDefaults {
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface NamedProfile {
  toolFormatProfile?: ToolFormatProfile;
  capabilityDefaults?: CapabilityDefaults;
  additionalSystemPrompts?: string[];
}

export interface ModelConfig {
  id: string;
  name?: string;
  /** Upstream API model id when catalog id differs (e.g. orchestrator alias). */
  upstreamModelId?: string;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  thinking?: boolean;
  streaming?: boolean;
  apiType?: string;
}

export type OverrideModelConfig = Partial<ModelConfig> & Record<string, unknown>;

export interface EndpointDiscoveryConfig {
  enabled?: boolean;
  modelsUrl?: string;
  refreshOnActivate?: boolean;
  ttlMinutes?: number;
}

export type EndpointAdapter =
  | "openai-pass-through"
  | "orchestrated-tools";

export interface EndpointConfig {
  id: string;
  displayName?: string;
  /** Upstream OpenAI-compatible chat completions URL for the reasoning model. */
  upstreamUrl: string;
  /** Plain-chat adapter; tool-bearing requests always use bind-and-return. */
  adapter: EndpointAdapter;
  adapterProfile?: string;
  apiKeySecretId?: string;
  models?: ModelConfig[];
  discoverModels?: EndpointDiscoveryConfig;
}

export interface SyncTargetConfig {
  id: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}

export interface InlineCompletionConfig {
  enabled?: boolean;
  endpointId?: string;
  modelId?: string;
  completionsPath?: string;
}

export interface OrchestratorModelSource {
  kind: "huggingface" | "github-release" | "mirror";
  url: string;
  sha256?: string;
}

export interface OrchestratorCatalogEntry {
  id: string;
  displayName: string;
  filename: string;
  ramHintGb: number;
  ctxSizeRecommended: number;
  sizeBytes: number;
  license: string;
  usModelCompliant: boolean;
  isDefault?: boolean;
  sources: OrchestratorModelSource[];
}

export interface OrchestratorModelConfig {
  id: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export type LlamaServerVariant =
  | "auto"
  | "cpu"
  | "cuda12"
  | "cuda13"
  | "vulkan"
  | "metal";

export interface DiagnosticHint {
  file: string;
  line: number;
  message: string;
  severity: string;
}

export interface WorkspaceContextPayload {
  roots: string[];
  openFiles: string[];
  recentFiles: string[];
  diagnostics: DiagnosticHint[];
}

export interface OrchestratorConfig {
  /** Base URL for llama-server during the bind phase. */
  llamaBaseUrl: string;
  llamaPort: number;
  /** Model id alias passed to llama-server; usually leave as orchestrator. */
  orchestratorModel: string;
  /** Local bind model catalog id (grammar-constrained tool-call synthesis). */
  selectedModelId: string;
  llamaServerVariant: LlamaServerVariant;
  llamaServerInstallDir: string;
  contextTokenBudget: number;
  localOnly: boolean;
  egressAllowlist: string[];
  llamaSlotId: number;
  llamaServerBinaryPath: string;
  modelPath: string;
  modelMirrorUrl: string;
  modelMirrorSha256: string;
  modelReleaseAsset: string;
  gpuLayers: number;
  ctxSize: number;
  /** Max tools considered during bind stage-one selection. */
  maxCandidateTools: number;
  /** Max tool calls emitted per assistant turn. */
  maxToolCallsPerTurn: number;
}

export interface LlmSidecarSettings {
  proxyPort: number;
  autoStartProxy: boolean;
  autoStartLlama: boolean;
  autoSyncOnActivate: boolean;
  proxyBinaryPath: string;
  profilesPath: string;
  modelCachePath: string;
  copilotByokSecretId: string;
  enforceHumanInTheLoop: boolean;
  profiles: Record<string, NamedProfile>;
  endpoints: EndpointConfig[];
  modelOverrides: Record<string, OverrideModelConfig>;
  syncTargets: SyncTargetConfig[];
  inlineCompletion: InlineCompletionConfig;
  orchestrator: OrchestratorConfig;
}

export interface ProxyConfigPayload {
  profiles: Record<string, NamedProfile>;
  endpoints: Array<EndpointConfig & { apiKey?: string }>;
  orchestrator: Omit<OrchestratorConfig, "llamaServerBinaryPath" | "modelPath" | "modelMirrorUrl" | "modelReleaseAsset" | "gpuLayers" | "ctxSize"> & {
    workspace: WorkspaceContextPayload;
  };
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  endpointId: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking: boolean;
  streaming: boolean;
  apiType?: string;
  extras?: Record<string, unknown>;
}

export interface ModelCatalog {
  proxyBaseUrl: string;
  models: ModelCatalogEntry[];
}

export interface ResolvedModel {
  id: string;
  name: string;
  endpointId: string;
  toolCalling: boolean;
  vision: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking: boolean;
  streaming: boolean;
  apiType?: string;
  extras: Record<string, unknown>;
}

export interface DiscoveredModelRow {
  id: string;
  name?: string;
}

export interface EndpointCacheEntry {
  fetchedAt: string;
  sourceUrl: string;
  models: DiscoveredModelRow[];
}

export interface ModelCacheFile {
  version: number;
  updatedAt: string;
  endpoints: Record<string, EndpointCacheEntry>;
}

export interface AuditLogEntry {
  timestamp: string;
  endpointId: string;
  model: string;
  upstreamUrl: string;
  emittedToolCalls: string[];
  localOnly: boolean;
}

export const MODEL_CACHE_VERSION = 1;

export const DEFAULT_MODEL_ID = "llama-3.2-3b-instruct-ud-q4";

export const ORCHESTRATOR_MODEL_CATALOG: OrchestratorCatalogEntry[] = [
  {
    id: "llama-3.2-3b-instruct-ud-q4",
    displayName: "Llama 3.2 3B Instruct (UD-Q4_K_XL)",
    filename: "Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf",
    ramHintGb: 8,
    ctxSizeRecommended: 8192,
    sizeBytes: 2_060_886_464,
    license: "Llama 3.2",
    usModelCompliant: true,
    isDefault: true,
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf",
        sha256:
          "2ca38452bd9f4348251abbc3f8234ecf0ddf9b96bfcbe639d4375b2721175d0b",
      },
    ],
  },
  {
    id: "phi-4-mini-instruct-q4",
    displayName: "Phi-4 mini Instruct (Q4_K_M)",
    filename: "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
    ramHintGb: 8,
    ctxSizeRecommended: 8192,
    sizeBytes: 2_490_000_000,
    license: "Microsoft Phi-4 mini",
    usModelCompliant: true,
    sources: [
      {
        kind: "huggingface",
        url: "https://huggingface.co/bartowski/microsoft_Phi-4-mini-instruct-GGUF/resolve/main/microsoft_Phi-4-mini-instruct-Q4_K_M.gguf",
        sha256:
          "01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2",
      },
    ],
  },
];

const defaultCatalogEntry =
  ORCHESTRATOR_MODEL_CATALOG.find((m) => m.isDefault) ??
  ORCHESTRATOR_MODEL_CATALOG[0]!;

/** @deprecated Use ORCHESTRATOR_MODEL_CATALOG and DEFAULT_MODEL_ID */
export const DEFAULT_ORCHESTRATOR_MODEL: OrchestratorModelConfig = {
  id: defaultCatalogEntry.id,
  url: defaultCatalogEntry.sources[0]?.url ?? "",
  sha256: defaultCatalogEntry.sources[0]?.sha256 ?? "",
  sizeBytes: defaultCatalogEntry.sizeBytes,
};

export const getCatalogEntry = (
  modelId: string
): OrchestratorCatalogEntry | undefined =>
  ORCHESTRATOR_MODEL_CATALOG.find((m) => m.id === modelId);

export const DEFAULT_SYNC_TARGETS: SyncTargetConfig[] = [
  {
    id: "chatLanguageModels",
    enabled: true,
    options: { providerName: "LLM Sidecar" },
  },
];

export const BUILTIN_PROFILES: Record<string, NamedProfile> = {
  "orchestrated-tools": {
    capabilityDefaults: {
      toolCalling: true,
      vision: false,
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    additionalSystemPrompts: [
      "Prefer concrete file paths from the provided workspace context.",
      "When a tool would help, describe which tool and why in plain prose.",
    ],
  },
  "chat-only": {
    capabilityDefaults: {
      toolCalling: false,
      vision: false,
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    additionalSystemPrompts: [
      "You are a coding assistant. Do not emit tool calls, XML tags, or function-call JSON.",
      "Provide concise explanations and concrete code edits in fenced code blocks when helpful.",
    ],
  },
  "gemini-non-customtools": {
    toolFormatProfile: {
      toolCallOpen: "<tool_use>",
      toolCallClose: "</tool_use>",
      toolResultOpen: "<tool_result>",
      toolResultClose: "</tool_result>",
      argumentFormat: "json-in-body",
      allowNativeTools: false,
      nameAttribute: "name",
      idAttribute: "id",
    },
    capabilityDefaults: {
      toolCalling: true,
      vision: false,
      maxInputTokens: 1_048_576,
      maxOutputTokens: 65_536,
    },
  },
};

export const DEFAULT_ORCHESTRATOR: OrchestratorConfig = {
  llamaBaseUrl: "http://127.0.0.1:8081",
  llamaPort: 8081,
  orchestratorModel: "orchestrator",
  selectedModelId: DEFAULT_MODEL_ID,
  llamaServerVariant: "auto",
  llamaServerInstallDir: "",
  contextTokenBudget: 12_000,
  localOnly: false,
  egressAllowlist: [],
  llamaSlotId: 0,
  llamaServerBinaryPath: "",
  modelPath: "",
  modelMirrorUrl: "",
  modelMirrorSha256: "",
  modelReleaseAsset: defaultCatalogEntry.sources[0]?.url ?? "",
  gpuLayers: -1,
  ctxSize: defaultCatalogEntry.ctxSizeRecommended,
  maxCandidateTools: 12,
  maxToolCallsPerTurn: 3,
};

/** @deprecated Use LlmSidecarSettings */
export type AiNormalizerSettings = LlmSidecarSettings;
