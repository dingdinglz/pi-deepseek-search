import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, ProviderSettingsStore, type ProviderSettings } from "./provider-settings.ts";

/** Selection is independent of the main conversation model; no cross-provider fallback. */
export function registerProviderCommand(pi: ExtensionAPI, store = new ProviderSettingsStore(), onChange: () => void = () => {}) {
  let settings: ProviderSettings = { ...DEFAULT_SETTINGS };
  let loadError: string | undefined;
  function updateStatus(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("web-provider", loadError
      ? "Web Search: unavailable"
      : `Web Search: ${settings.provider === "openai" ? "OpenAI Codex" : "DeepSeek"}`);
  }
  pi.on("session_start", async (_event, ctx) => {
    try {
      settings = await store.read();
      loadError = undefined;
      onChange();
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Cannot load web provider settings.";
      ctx.ui.notify(loadError, "error");
    } finally {
      updateStatus(ctx);
    }
  });
  pi.registerCommand("web-provider", {
    description: "Switch web tools: /web-provider deepseek | openai [Codex model]; selection persists",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) {
        ctx.ui.notify(loadError ?? `Web provider: ${settings.provider}${settings.provider === "openai" ? ` (${settings.model})` : ""}. Use /web-provider deepseek or /web-provider openai [model].`, loadError ? "error" : "info");
        if (!ctx.hasUI) return;
        const selected = await ctx.ui.select("Web search/fetch provider", ["deepseek", "openai"]);
        if (!selected) return;
        parts.push(selected);
      }
      const [provider, model] = parts;
      if ((provider !== "deepseek" && provider !== "openai") || parts.length > 2 || (provider === "deepseek" && model)) {
        ctx.ui.notify("Use /web-provider deepseek or /web-provider openai [Codex model ID].", "warning");
        return;
      }
      const next: ProviderSettings = { provider, model: model ?? settings.model };
      try {
        await ctx.waitForIdle();
        await store.save(next);
        settings = next;
        loadError = undefined;
        try { onChange(); }
        catch {
          loadError = "Cannot refresh web tool definitions. Run /reload before using web tools.";
          throw new Error(loadError);
        }
        ctx.ui.notify(provider === "openai"
          ? `Web tools: OpenAI Codex (${next.model}). Uses Pi's openai-codex login and direct alpha search API; pages may be excerpts.`
          : "Web tools: DeepSeek. Uses the key saved by /deepseek-key.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Cannot save web provider settings.", "error");
      } finally {
        updateStatus(ctx);
      }
    },
  });
  return () => {
    if (loadError) throw new Error(loadError);
    return { ...settings };
  };
}
