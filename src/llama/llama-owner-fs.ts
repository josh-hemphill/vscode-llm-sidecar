import * as fs from "node:fs/promises";
import * as path from "node:path";

const OWNER_FILENAME = "llama-owner.json";

export interface LlamaOwnerRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export const llamaOwnerPath = (baseDir: string): string =>
  path.join(baseDir, OWNER_FILENAME);

export const readLlamaOwnerFromDir = async (
  baseDir: string
): Promise<LlamaOwnerRecord | undefined> => {
  try {
    const raw = await fs.readFile(llamaOwnerPath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as LlamaOwnerRecord;
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

export const writeLlamaOwnerToDir = async (
  baseDir: string,
  pid: number,
  port: number
): Promise<void> => {
  await fs.mkdir(baseDir, { recursive: true });
  const record: LlamaOwnerRecord = {
    pid,
    port,
    startedAt: new Date().toISOString(),
  };
  const file = llamaOwnerPath(baseDir);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
};

export const clearLlamaOwnerFromDir = async (baseDir: string): Promise<void> => {
  try {
    await fs.unlink(llamaOwnerPath(baseDir));
  } catch {
    /* absent */
  }
};
