import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type WebProvider = "deepseek" | "openai";

export interface ProviderSettings {
  provider: WebProvider;
  model: string;
}

export const DEFAULT_SETTINGS: Readonly<ProviderSettings> = Object.freeze({
  provider: "deepseek",
  model: "auto",
});

function validSettings(value: unknown): value is ProviderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "provider" in value && (value.provider === "deepseek" || value.provider === "openai")
    && "model" in value && typeof value.model === "string"
    && value.model.length > 0 && value.model.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value.model) && !/\s/.test(value.model);
}

/** Nonsecret web provider preferences, separate from credentials. */
export class ProviderSettingsStore {
  constructor(readonly path = join(getAgentDir(), "deepseek-search", "settings.json")) {}

  async read(): Promise<ProviderSettings> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!validSettings(data)) throw new Error("Invalid settings file");
      return { provider: data.provider, model: data.model };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
      // Parser errors may include file contents: never forward them.
      throw new Error("Cannot read the saved web provider settings. Check permissions and repair or remove the settings.json file before retrying.");
    }
  }

  async save(settings: ProviderSettings): Promise<void> {
    if (!validSettings(settings)) {
      throw new Error("Invalid web provider settings; expected provider deepseek or openai and a model of 1–128 letters, digits, dots, underscores, colons or hyphens, without whitespace.");
    }
    const data = { provider: settings.provider, model: settings.model };
    // Do not silently replace an unreadable or malformed existing file.
    await this.read();
    const directory = dirname(this.path);
    const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporary, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } catch {
      throw new Error("Cannot save the web provider settings. Check permissions on the settings directory.");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
