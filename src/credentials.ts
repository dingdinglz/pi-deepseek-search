import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function validApiKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]+$/.test(key);
}

/** Separate from provider credentials; never resolves environment variables or shell commands. */
export class KeyStore {
  constructor(readonly path = join(getAgentDir(), "deepseek-search", "key.json")) {}

  async read(): Promise<string | undefined> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!data || typeof data !== "object" || !("apiKey" in data) || typeof data.apiKey !== "string" || !validApiKey(data.apiKey)) {
        throw new Error("Invalid key file");
      }
      return data.apiKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // JSON parser errors can include the secret: never forward them.
      throw new Error("Cannot read the saved DeepSeek key. Run /deepseek-key to replace it.");
    }
  }

  async save(value: string): Promise<void> {
    const key = value.trim();
    if (!validApiKey(key)) throw new Error("Invalid DeepSeek key format; expected sk-… without whitespace.");
    const directory = dirname(this.path);
    const temporary = join(directory, `.key-${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, JSON.stringify({ apiKey: key }) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } catch {
      throw new Error("Cannot save the DeepSeek key. Check permissions on the Pi agent directory.");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async clear(): Promise<void> {
    try { await rm(this.path, { force: true }); }
    catch { throw new Error("Cannot remove the DeepSeek key. Check permissions on the Pi agent directory."); }
  }
}
