import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { FetchData, SearchData } from "../src/schemas.ts";
import { KeyStore } from "../src/credentials.ts";

// Explicit opt-in only: these requests use the real, billable API.
if (!await new KeyStore().read()) throw new Error("First run /deepseek-key in Pi's TUI, then run this script.");
const root = fileURLToPath(new URL("../", import.meta.url));
const empty = await mkdtemp(join(tmpdir(), "pi-deepseek-smoke-"));
try {
  const loaded = await discoverAndLoadExtensions([root], empty, empty);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  const registered = loaded.extensions[0]?.tools;
  assert.ok(registered);
  console.log("PASS Pi loader: " + [...registered.keys()].join(", "));

  const cases = [
    { name: "deepseek_search", input: { query: "DeepSeek API search fetch site:api-docs.deepseek.com", count: 3 } },
    { name: "deepseek_search", input: { query: "DeepSeek API", count: 1, need_content: true } },
    { name: "deepseek_fetch", input: { url: "https://api-docs.deepseek.com/zh-cn/guides/search" } },
  ];
  for (const { name, input } of cases) {
    const tool = registered.get(name)!.definition;
    assert.ok(Value.Check(tool.parameters, input));
    const start = performance.now();
    const result = await tool.execute("smoke", input, undefined, undefined, {} as ExtensionToolContext);
    assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
    if (name === "deepseek_search") {
      const data = result.structuredContent as SearchData;
      assert.ok(data.results.length > 0, "Live search should return at least one source");
      assert.ok(data.results.length <= input.count!);
      assert.ok(data.results.every(r => /^https?:\/\//.test(r.url)));
      console.log(`PASS ${name} (${Math.round(performance.now() - start)}ms): ${data.results.length} results; need_content=${input.need_content ?? false}; content bytes=${data.results.reduce((n, r) => n + Buffer.byteLength(r.content), 0)}`);
      console.log(`  First source: ${data.results[0].url}`);
    } else {
      const data = result.structuredContent as FetchData;
      assert.ok(data.content.trim().length > 0, "Live fetch should return Markdown");
      assert.match(data.content, /Search/i);
      assert.match(data.content, /Fetch/i);
      console.log(`PASS ${name} (${Math.round(performance.now() - start)}ms): ${data.title}; ${Buffer.byteLength(data.content)} bytes`);
    }
  }
} finally {
  await rm(empty, { recursive: true, force: true });
}
