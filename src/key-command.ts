import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, Text, matchesKey } from "@earendil-works/pi-tui";
import { KeyStore, validApiKey } from "./credentials.ts";

/** Reuse Pi's editing/paste handling, but never render the underlying value. */
export class SecretInput extends Input {
  override render(width: number): string[] {
    const entered = this.getValue().length > 0;
    return new Text([
      "DeepSeek API key",
      "",
      entered ? "●●●●●●●●  (hidden)" : "Paste your API key…",
      "",
      "Enter: save · Esc: cancel",
      "Saved locally as plaintext with owner-only permissions.",
    ].join("\n"), 0, 0).render(width);
  }

  override handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) this.onEscape?.();
    else super.handleInput(data);
  }
}

export function registerKeyCommand(pi: ExtensionAPI, store: KeyStore): void {
  pi.registerCommand("deepseek-key", {
    description: "Set the DeepSeek API key securely in a dialog; use 'clear' to remove it",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("Run /deepseek-key in Pi's interactive TUI to manage the key.", "warning");
        return;
      }
      const action = args.trim();
      if (action && action !== "clear") {
        ctx.ui.notify("Use /deepseek-key without a key argument, or /deepseek-key clear.", "warning");
        return;
      }
      try {
        if (action === "clear") {
          if (await ctx.ui.confirm("Remove DeepSeek key?", "Search and fetch will require a new key.")) {
            await store.clear();
            ctx.ui.notify("DeepSeek key removed.", "info");
          }
          return;
        }
        const value = await ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
          const input = new SecretInput();
          input.onSubmit = value => {
            if (!validApiKey(value.trim())) {
              ctx.ui.notify("Invalid key format. Paste a key starting with sk- and without whitespace.", "warning");
              tui.requestRender();
              return;
            }
            done(value.trim());
          };
          input.onEscape = () => done(undefined);
          return input;
        });
        if (value === undefined) return;
        await store.save(value);
        ctx.ui.notify("DeepSeek key saved. Search and fetch can use it immediately.", "info");
      } catch (error) {
        // Store errors are deliberately generic and contain no key material.
        ctx.ui.notify(error instanceof Error ? error.message : "Unable to update the DeepSeek key.", "error");
      }
    },
  });
}
