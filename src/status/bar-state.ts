export type StatusBarTone = "normal" | "warning" | "error";

export interface StatusBarView {
  text: string;
  tooltip: string;
  command: string;
  tone: StatusBarTone;
}

/** Derives status bar label, tooltip, command, and error styling. */
export const buildStatusBarView = (input: {
  proxyBaseUrl: string | undefined;
  llamaBaseUrl: string | undefined;
  hitlEnforced: boolean;
  endpointCount: number;
  missingEndpointLabels: string[];
}): StatusBarView => {
  if (input.endpointCount === 0) {
    return {
      text: "$(add) LLM Sidecar: add endpoint",
      tooltip:
        "No upstream endpoints configured. Click to add your first endpoint.",
      command: "llmSidecar.addFirstEndpoint",
      tone: "warning",
    };
  }

  if (input.missingEndpointLabels.length > 0) {
    const names = input.missingEndpointLabels.join(", ");
    return {
      text: "$(key) LLM Sidecar: set API key",
      tooltip: `Missing upstream API key for: ${names}. Click to set.`,
      command: "llmSidecar.setEndpointApiKey",
      tone: "error",
    };
  }

  const shield = input.hitlEnforced ? "$(shield)" : "$(warning)";
  const proxyShort = input.proxyBaseUrl
    ? input.proxyBaseUrl.replace("http://127.0.0.1:", "p:")
    : "off";
  const llamaShort = input.llamaBaseUrl
    ? input.llamaBaseUrl.replace("http://127.0.0.1:", "l:")
    : "off";

  if (input.proxyBaseUrl) {
    return {
      text: `${shield} Sidecar ${proxyShort} | llama ${llamaShort}`,
      tooltip: `Proxy: ${input.proxyBaseUrl}\nLlama: ${input.llamaBaseUrl ?? "stopped"}\nHITL: ${input.hitlEnforced ? "enforced" : "off"}`,
      command: "llmSidecar.syncLanguageModels",
      tone: "normal",
    };
  }

  return {
    text: "$(cloud-offline) LLM Sidecar: stopped",
    tooltip: "Proxy stopped — click to start",
    command: "llmSidecar.startProxy",
    tone: "normal",
  };
};
