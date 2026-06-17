import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { resolveEditorUserFolder } from "./editor-paths.ts";

export { resolveEditorUserFolder } from "./editor-paths.ts";

/** Resolve User/chatLanguageModels.json for the running editor (Code, Insiders, Cursor). */
export const resolveChatLanguageModelsPath = (): string => {
  const base = resolveEditorUserFolder(
    vscode.env.appName,
    process.platform,
    os.homedir(),
    process.env.APPDATA
  );
  return path.join(base, "chatLanguageModels.json");
};
