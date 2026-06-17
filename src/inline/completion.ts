import * as vscode from "vscode";
import { getSettings } from "../config/store.ts";
import { getProxyBaseUrl } from "../proxy/process.ts";

/** Optional inline completion provider when user enables llmSidecar.inlineCompletion. */
export const registerInlineCompletion = (
  context: vscode.ExtensionContext
): void => {
  const settings = getSettings();
  if (!settings.inlineCompletion.enabled) {
    return;
  }

  const provider: vscode.InlineCompletionItemProvider = {
    provideInlineCompletionItems: async (document, position, _ctx, token) => {
      const base = getProxyBaseUrl();
      if (!base) {
        return undefined;
      }
      const firstEndpoint = settings.endpoints[0];
      const modelId =
        settings.inlineCompletion.modelId ??
        firstEndpoint?.models?.[0]?.id;
      if (!modelId) {
        return undefined;
      }
      const prefix = document.getText(
        new vscode.Range(
          new vscode.Position(Math.max(0, position.line - 30), 0),
          position
        )
      );
      const suffix = document.getText(
        new vscode.Range(
          position,
          new vscode.Position(
            Math.min(document.lineCount - 1, position.line + 10),
            0
          )
        )
      );
      const path =
        settings.inlineCompletion.completionsPath ?? "/v1/completions";
      const body = {
        model: modelId,
        prompt: prefix,
        suffix,
        max_tokens: 128,
        stream: false,
      };
      try {
        if (token.isCancellationRequested) {
          return undefined;
        }
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (token.isCancellationRequested) {
          return undefined;
        }
        if (!res.ok) {
          return undefined;
        }
        const json = (await res.json()) as {
          choices?: Array<{ text?: string }>;
        };
        const text = json.choices?.[0]?.text;
        if (!text) {
          return undefined;
        }
        return [
          new vscode.InlineCompletionItem(
            text,
            new vscode.Range(position, position)
          ),
        ];
      } catch {
        return undefined;
      }
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      [{ pattern: "**" }],
      provider
    )
  );
};
