import * as fs from "node:fs/promises";
import * as path from "node:path";

const OWNER_FILENAME = "proxy-owner.json";

export interface ProxyOwnerRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export const proxyOwnerPath = (baseDir: string): string =>
  path.join(baseDir, OWNER_FILENAME);

export const readProxyOwnerFromDir = async (
  baseDir: string
): Promise<ProxyOwnerRecord | undefined> => {
  try {
    const raw = await fs.readFile(proxyOwnerPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as ProxyOwnerRecord;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.port !== "number" ||
      !parsed.startedAt
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
};

export const writeProxyOwnerToDir = async (
  baseDir: string,
  pid: number,
  port: number
): Promise<void> => {
  await fs.mkdir(baseDir, { recursive: true });
  const record: ProxyOwnerRecord = {
    pid,
    port,
    startedAt: new Date().toISOString(),
  };
  const file = proxyOwnerPath(baseDir);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
};

export const clearProxyOwnerFromDir = async (baseDir: string): Promise<void> => {
  try {
    await fs.unlink(proxyOwnerPath(baseDir));
  } catch {
    /* absent */
  }
};
