import type * as vscode from "vscode";

export interface ProxyChatProbeResult {
  ok: boolean;
  status: number;
  model: string;
  stream: boolean;
  detail: string;
  bodyPreview: string;
}

/** Sends a minimal chat completion through the local proxy for troubleshooting. */
export const probeProxyChat = async (
  baseUrl: string,
  modelId: string,
  options?: { stream?: boolean; apiKey?: string }
): Promise<ProxyChatProbeResult> => {
  const stream = options?.stream ?? true;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options?.apiKey?.trim()) {
    headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  }
  const body = {
    model: modelId,
    messages: [{ role: "user", content: "Reply with exactly: sidecar-ok" }],
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    max_tokens: 32,
  };
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const preview =
      text.length > 600 ? `${text.slice(0, 600)}…` : text;
    return {
      ok: res.ok,
      status: res.status,
      model: modelId,
      stream,
      detail: res.ok
        ? "Proxy returned a response body."
        : `HTTP ${res.status} from proxy`,
      bodyPreview: preview,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      model: modelId,
      stream,
      detail: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      bodyPreview: "",
    };
  }
};

/** Runs proxy health + chat probes and writes results to the output channel. */
export const runProxyDiagnostics = async (
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  baseUrl: string,
  modelId: string
): Promise<ProxyChatProbeResult[]> => {
  const { getEndpointApiKey } = await import("../secrets/prompt.ts");
  const { getSettings } = await import("../config/store.ts");
  const settings = getSettings();
  const ep = settings.endpoints[0];
  const apiKey = ep ? await getEndpointApiKey(context, ep) : undefined;

  log.appendLine("--- LLM Sidecar diagnostics ---");
  log.appendLine(`Proxy base: ${baseUrl}`);
  log.appendLine(`Model: ${modelId}`);
  log.appendLine(
    `Endpoint API key: ${apiKey ? "set (via SecretStorage)" : "not set"}`
  );

  try {
    const health = await fetch(`${baseUrl}/health`);
    log.appendLine(`GET /health -> ${health.status}`);
  } catch (err) {
    log.appendLine(
      `GET /health failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const results: ProxyChatProbeResult[] = [];
  for (const stream of [false, true] as const) {
    const result = await probeProxyChat(baseUrl, modelId, { stream, apiKey });
    results.push(result);
    log.appendLine(
      `POST /v1/chat/completions stream=${stream} -> ${result.status} ${result.ok ? "ok" : "FAILED"}`
    );
    if (result.bodyPreview) {
      log.appendLine(result.bodyPreview);
    }
  }
  log.appendLine("--- end diagnostics ---");
  return results;
};
