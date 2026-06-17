import * as path from "node:path";

/** Editor config folder name under user data (Code, Insiders, Cursor). */
export const resolveEditorUserFolder = (
  appName: string,
  platform: NodeJS.Platform = process.platform,
  home: string,
  appData?: string
): string => {
  let folder = "Code";
  if (appName.includes("Insiders")) {
    folder = "Code - Insiders";
  } else if (appName.toLowerCase().includes("cursor")) {
    folder = "Cursor";
  }
  const base =
    platform === "win32"
      ? path.join(appData ?? path.join(home, "AppData", "Roaming"), folder, "User")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support", folder, "User")
        : path.join(home, ".config", folder, "User");
  return base;
};
