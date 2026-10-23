import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerProviderCommand } from "../src/provider-command.ts";
import { DEFAULT_SETTINGS, type ProviderSettings, type ProviderSettingsStore } from "../src/provider-settings.ts";

function setup(initial = DEFAULT_SETTINGS, failRead = false, failSave = false, onChange = () => {}) {
  let saved = { ...initial };
  let start: Function;
  let command: Function;
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const pi = {
    getActiveTools: () => { throw new Error("Provider switching must not inspect the tool loadout"); },
    setActiveTools: () => { throw new Error("Provider switching must not change the tool loadout"); },
    registerTool: () => { throw new Error("Provider switching must not re-register tools"); },
    on: (_event: string, handler: Function) => { start = handler; },
    registerCommand: (_name: string, spec: { handler: Function }) => { command = spec.handler; },
  } as unknown as ExtensionAPI;
  const store = {
    read: async () => { if (failRead) throw new Error("Invalid settings"); return { ...saved }; },
    save: async (value: ProviderSettings) => { if (failSave) throw new Error("Cannot save"); saved = { ...value }; },
  } as ProviderSettingsStore;
  const ctx = {
    mode: "print", hasUI: false,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
    },
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;
  const current = registerProviderCommand(pi, store, onChange);
  return { current, notices, statuses, ctx, saved: () => saved, start: () => start({}, ctx), command: (args: string) => command(args, ctx) };
}

test("provider selection restores and persists requested configuration", async () => {
  const h = setup({ provider: "openai", model: "gpt-5.4" });
  await h.start();
  assert.deepEqual(h.current(), { provider: "openai", model: "gpt-5.4" });
  await h.command("deepseek");
  assert.equal(h.current().provider, "deepseek");
  await h.command("openai gpt-5.4-mini");
  assert.deepEqual(h.saved(), { provider: "openai", model: "gpt-5.4-mini" });
  assert.deepEqual(h.current(), h.saved());
});

test("invalid command and failed saves leave current selection unchanged", async () => {
  const h = setup(DEFAULT_SETTINGS, false, true);
  await h.start();
  for (const args of ["other", "deepseek model", "openai a b", "openai"]) await h.command(args);
  assert.deepEqual(h.current(), DEFAULT_SETTINGS);
  assert.match(h.notices.at(-1)!, /Cannot save/);
});

test("bad settings block execution rather than silently falling back", async () => {
  const h = setup(DEFAULT_SETTINGS, true, true);
  await h.start();
  assert.throws(h.current, /Invalid settings/);
  await h.command("");
  assert.match(h.notices.at(-1)!, /Invalid settings/);
  await h.command("openai");
  assert.throws(h.current, /Invalid settings/);
});

test("successfully saved settings clear a previous configuration error", async () => {
  const h = setup(DEFAULT_SETTINGS, true);
  await h.start();
  assert.throws(h.current, /Invalid settings/);
  await h.command("openai");
  assert.equal(h.current().provider, "openai");
});

test("failed schema refresh blocks execution until definitions can be restored", async () => {
  let fail = false;
  let refreshes = 0;
  const h = setup(DEFAULT_SETTINGS, false, false, () => {
    refreshes++;
    if (fail) throw new Error("Refresh failed");
  });
  await h.start();
  assert.equal(refreshes, 1);
  fail = true;
  await h.command("openai");
  assert.equal(refreshes, 2);
  assert.equal(h.saved().provider, "openai");
  assert.throws(h.current, /Cannot refresh web tool definitions/);
  fail = false;
  await h.start();
  assert.equal(h.current().provider, "openai");
});

test("footer restores the provider and follows successful switches", async () => {
  const h = setup({ provider: "openai", model: "gpt-5.4" });
  h.ctx.mode = "tui";
  await h.start();
  assert.equal(h.statuses.get("web-provider"), "Web Search: OpenAI Codex");
  await h.command("deepseek");
  assert.equal(h.statuses.get("web-provider"), "Web Search: DeepSeek");
  await h.command("openai gpt-5.4-mini");
  assert.equal(h.statuses.get("web-provider"), "Web Search: OpenAI Codex");
  assert.equal(h.statuses.size, 1);
});

test("footer preserves the current provider on invalid input and failed saves", async () => {
  const h = setup(DEFAULT_SETTINGS, false, true);
  h.ctx.mode = "tui";
  await h.start();
  for (const args of ["other", "deepseek model", "openai"]) {
    await h.command(args);
    assert.equal(h.statuses.get("web-provider"), "Web Search: DeepSeek");
  }
});

test("footer marks invalid settings unavailable and recovers after a successful switch", async () => {
  const h = setup(DEFAULT_SETTINGS, true);
  h.ctx.mode = "tui";
  await h.start();
  assert.equal(h.statuses.get("web-provider"), "Web Search: unavailable");
  await h.command("openai");
  assert.equal(h.statuses.get("web-provider"), "Web Search: OpenAI Codex");
});

test("footer does not claim a provider is available when tool refresh fails", async () => {
  let fail = false;
  const h = setup(DEFAULT_SETTINGS, false, false, () => {
    if (fail) throw new Error("Refresh failed");
  });
  h.ctx.mode = "tui";
  await h.start();
  fail = true;
  await h.command("openai");
  assert.equal(h.statuses.get("web-provider"), "Web Search: unavailable");
  fail = false;
  await h.start();
  assert.equal(h.statuses.get("web-provider"), "Web Search: OpenAI Codex");
});

test("footer follows menu selection and stays unchanged on cancellation", async () => {
  const h = setup();
  h.ctx.mode = "tui";
  h.ctx.hasUI = true;
  await h.start();
  h.ctx.ui.select = async () => undefined;
  await h.command("");
  assert.equal(h.statuses.get("web-provider"), "Web Search: DeepSeek");
  h.ctx.ui.select = async () => "openai";
  await h.command("");
  assert.equal(h.statuses.get("web-provider"), "Web Search: OpenAI Codex");
});

test("non-TUI modes never set a footer status", async () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const h = setup();
    h.ctx.mode = mode;
    await h.start();
    await h.command("openai");
    assert.equal(h.statuses.size, 0);
  }
});

test("non-interactive status does not change settings", async () => {
  const h = setup();
  await h.start();
  await h.command("");
  assert.match(h.notices.at(-1)!, /Web provider: deepseek/);
  assert.deepEqual(h.saved(), DEFAULT_SETTINGS);
});
