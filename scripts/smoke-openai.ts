import assert from "node:assert/strict";
import { ModelRegistry, ModelRuntime, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createTools } from "../index.ts";
import { ProviderSettingsStore } from "../src/provider-settings.ts";
import { WebTextResponse } from "../src/web-schemas.ts";

// Explicit opt-in only: two real Codex web requests, which may consume account quota.
// No model inference, transcript forwarding, provider selection change or token logging.
const settings = await new ProviderSettingsStore().read();
const modelId = process.argv[2] ?? settings.model;
let registry: ModelRegistry;
try {
  registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }));
} catch {
  throw new Error("Unable to initialize Pi's model runtime; check your Pi configuration.");
}
const ctx = { modelRegistry: registry } as ExtensionToolContext;
const tools = createTools(undefined, () => ({ provider: "openai", model: modelId }));
const cases = [
  { name: "search", expected: /developers\.openai\.com/i, run: () => tools.search.execute("smoke-search", { query: "OpenAI Codex documentation", domains: ["developers.openai.com"] }, undefined, undefined, ctx) },
  { name: "fetch", expected: /Example Domain/i, run: () => tools.fetch.execute("smoke-fetch", { url: "https://example.com", lineno: 0 }, undefined, undefined, ctx) },
];
for (const { name, expected, run } of cases) {
  const start = performance.now();
  const result = await run();
  const data = result.structuredContent;
  assert.ok(Value.Check(WebTextResponse, data), "Response should match output schema");
  assert.ok(expected.test(data.output), "Service output must contain the expected source/page, not just an HTTP success or error text");
  console.log(`PASS ${name} (${Math.round(performance.now() - start)}ms): ${Buffer.byteLength(data.output)} output bytes; structured results: ${data.results?.length ?? "not supplied"}`);
}
