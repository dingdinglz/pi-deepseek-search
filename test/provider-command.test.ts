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
  const ctx = { hasUI: false, ui: { notify: (text: string) => notices.push(text) }, waitForIdle: async () => {} } as unknown as ExtensionCommandContext;
  const current = registerProviderCommand(pi, store, onChange);
  return { current, notices, saved: () => saved, start: () => start({}, ctx), command: (args: string) => command(args, ctx) };
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

test("non-interactive status does not change settings", async () => {
  const h = setup();
  await h.start();
  await h.command("");
  assert.match(h.notices.at(-1)!, /Web provider: deepseek/);
  assert.deepEqual(h.saved(), DEFAULT_SETTINGS);
});
