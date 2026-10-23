import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { TObject } from "typebox";
import { createTools } from "../index.ts";
import { DeepSeekClient } from "../src/client.ts";
import { registerProviderCommand } from "../src/provider-command.ts";
import { DEFAULT_SETTINGS, type ProviderSettings, type ProviderSettingsStore } from "../src/provider-settings.ts";

const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const ctx = { modelRegistry: {
  find: (_provider: string, id: string) => ({ id, provider: "openai-codex", api: "openai-codex-responses" }),
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
} } as unknown as ExtensionToolContext;

function declarations(tools: ReturnType<typeof createTools>) {
  return JSON.stringify(Object.values(tools).map(({ name, label, description, namespace, parameters, outputSchema, promptSnippet, promptGuidelines }) =>
    ({ name, label, description, namespace, parameters, outputSchema, promptSnippet, promptGuidelines })));
}

test("declarations expose only selected capabilities and never name a provider", () => {
  const standard = createTools();
  const excerpts = createTools(undefined, () => ({ provider: "openai", model: "auto" }));
  for (const tools of [standard, excerpts]) {
    assert.deepEqual([tools.search.name, tools.fetch.name], ["search", "fetch"]);
    assert.doesNotMatch(declarations(tools), /deepseek|openai|codex/i);
    assert.equal(tools.search.parameters.additionalProperties, false);
    assert.equal(tools.fetch.parameters.additionalProperties, false);
  }
  assert.deepEqual(Object.keys(standard.search.parameters.properties), ["query", "count", "need_content", "ori_question", "localization"]);
  assert.deepEqual(Object.keys(excerpts.search.parameters.properties), ["query", "recency", "domains", "response_length"]);
  assert.deepEqual(Object.keys(standard.fetch.parameters.properties), ["url"]);
  assert.deepEqual(Object.keys(excerpts.fetch.parameters.properties), ["url", "lineno", "response_length"]);
  assert.equal(standard.search.parameters.properties.query.maxLength, 128);
  assert.equal(excerpts.search.parameters.properties.query.maxLength, 4000);
  assert.notDeepEqual(standard.search.outputSchema, excerpts.search.outputSchema);
});

test("restore and commands replace schemas under the same two registered tool names", async () => {
  let saved: ProviderSettings = { provider: "openai", model: "auto" };
  const tools = new Map<string, ToolDefinition<TObject>>();
  let start: Function;
  let command: Function;
  const pi = {
    registerTool: (tool: ToolDefinition<TObject>) => tools.set(tool.name, tool),
    on: (_event: string, handler: Function) => { start = handler; },
    registerCommand: (_name: string, spec: { handler: Function }) => { command = spec.handler; },
    setActiveTools: () => assert.fail("Do not change the user's tool loadout"),
  } as unknown as ExtensionAPI;
  const store = { read: async () => ({ ...saved }), save: async (next: ProviderSettings) => { saved = { ...next }; } } as ProviderSettingsStore;
  const settings = registerProviderCommand(pi, store, refresh);
  function refresh() {
    const next = createTools(undefined, settings);
    pi.registerTool(next.search);
    pi.registerTool(next.fetch);
  }
  const context = { hasUI: false, waitForIdle: async () => {}, ui: { notify: () => {} } } as unknown as ExtensionCommandContext;
  refresh();
  const original = tools.get("search")!;
  await start!({}, context);
  assert.notEqual(tools.get("search"), original);
  assert.ok("recency" in tools.get("search")!.parameters.properties);
  assert.ok("lineno" in tools.get("fetch")!.parameters.properties);
  await command!("deepseek", context);
  assert.ok("count" in tools.get("search")!.parameters.properties);
  assert.deepEqual(Object.keys(tools.get("fetch")!.parameters.properties), ["url"]);
  await command!("openai", context);
  assert.ok("recency" in tools.get("search")!.parameters.properties);
  assert.deepEqual([...tools.keys()], ["search", "fetch"]);
});

test("refreshed definitions route correctly and remove backend metadata from results", async t => {
  let settings: ProviderSettings = { provider: "deepseek", model: "codex-test" };
  const requests: string[] = [];
  const client = new DeepSeekClient({ apiKey: () => "test-key", fetch: async url => {
    requests.push(String(url));
    return Response.json(String(url).endsWith("/search") ? { results: [] } : { title: "Page", content: "Markdown" });
  } });
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    requests.push(String(url));
    return Response.json({ output: "Retrieved page/search text", results: [] });
  });
  let previous: ReturnType<typeof createTools> | undefined;
  for (const provider of ["deepseek", "openai", "deepseek"] as const) {
    settings = { ...settings, provider };
    if (previous) {
      await assert.rejects(previous.search.execute("stale", { query: "query" }, undefined, undefined, ctx), /configuration changed/);
      await assert.rejects(previous.fetch.execute("stale", { url: "https://example.com" }, undefined, undefined, ctx), /configuration changed/);
    }
    const tools = createTools(client, () => settings);
    const search = await tools.search.execute("search", { query: "query" }, undefined, undefined, ctx);
    const page = await tools.fetch.execute("fetch", { url: "https://example.com" }, undefined, undefined, ctx);
    assert.ok(Value.Check(tools.search.outputSchema!, search.structuredContent));
    assert.ok(Value.Check(tools.fetch.outputSchema!, page.structuredContent));
    assert.doesNotMatch(JSON.stringify([search, page]), /deepseek|openai|codex|"provider"|"model"/i);
    previous = tools;
  }
  assert.deepEqual(requests, [
    "https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch",
    "https://chatgpt.com/backend-api/codex/alpha/search", "https://chatgpt.com/backend-api/codex/alpha/search",
    "https://api.deepseek.com/v1/tools/search", "https://api.deepseek.com/v1/tools/fetch",
  ]);
});

test("arguments absent from current schemas fail neutrally before any request", async t => {
  const client = new DeepSeekClient({ apiKey: () => assert.fail("No authentication expected") });
  t.mock.method(globalThis, "fetch", async () => assert.fail("No HTTP expected"));
  const tools = createTools(client);
  for (const input of [{ recency: 7 }, { domains: ["example.com"] }, { response_length: "long" as const }]) {
    await assert.rejects(tools.search.execute("search", { query: "query", ...input }, undefined, undefined, ctx), /Invalid search parameters/);
  }
  for (const input of [{ lineno: 0 }, { response_length: "short" as const }]) {
    await assert.rejects(tools.fetch.execute("fetch", { url: "https://example.com", ...input }, undefined, undefined, ctx), /Invalid fetch parameters/);
  }
  await assert.rejects(tools.search.execute("search", { query: "x".repeat(129) }, undefined, undefined, ctx), /Invalid search parameters/);
  const other = createTools(client, () => ({ provider: "openai", model: "auto" }));
  for (const input of [{ count: 10 }, { need_content: false }, { ori_question: null }, { localization: "1.1.1.1" }]) {
    await assert.rejects(other.search.execute("search", { query: "query", ...input }, undefined, undefined, ctx), /Invalid search parameters/);
  }
});

test("configuration errors stop both tools before accessing clients or credentials", async () => {
  let invalid = false;
  const tools = createTools(undefined, () => {
    if (invalid) throw new Error("Invalid settings");
    return { ...DEFAULT_SETTINGS };
  });
  invalid = true;
  await assert.rejects(tools.search.execute("search", { query: "query" }, undefined, undefined, ctx), /Invalid settings/);
  await assert.rejects(tools.fetch.execute("fetch", { url: "https://example.com" }, undefined, undefined, ctx), /Invalid settings/);
});
