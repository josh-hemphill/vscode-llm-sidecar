import * as vscode from "vscode";

const OUTPUT_CHANNEL = "LLM Sidecar";

let channel: vscode.OutputChannel | undefined;

/** Returns the singleton LLM Sidecar output channel. */
export const getOutputChannel = (): vscode.OutputChannel => {
  if (!channel) {
    channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL);
  }
  return channel;
};

/** Disposes the singleton output channel (extension deactivate). */
export const disposeOutputChannel = (): void => {
  channel?.dispose();
  channel = undefined;
};
