import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions, type ExtensionToolContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createTools } from "../index.ts";
import { DeepSeekClient } from "../src/client.ts";
import { safeText, toolResult } from "../src/output.ts";

const item = {
  title: "DeepSeek Docs", url: "https://api-docs.deepseek.com/", summary: "A useful summary.",
  snippet: "Short snippet", content: "", date: null, site_name: "DeepSeek", site_icon: null,
  rerank_score: 2.5, authority: 4,
};
const ctx = {} as ExtensionToolContext;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const renderContext = { isError: false } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
function tools(data: object) {
  return createTools(new DeepSeekClient({ apiKey: () => "test", fetch: async () => new Response(JSON.stringify(data)) }));
}

test("Pi's actual loader discovers exactly two tools from the package manifest", async () => {
  const empty = await mkdtemp(join(tmpdir(), "pi-deepseek-loader-"));
  try {
    const loaded = await discoverAndLoadExtensions([resolve(".")], empty, empty);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.warnings ?? [], []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0].tools.keys()], ["deepseek_search", "deepseek_fetch"]);
  } finally { await rm(empty, { recursive: true, force: true }); }
});

test("search output has citations, summaries and valid structured data", async () => {
  const tool = tools({ results: [item] }).search;
  const result = await tool.execute("test", { query: "DeepSeek" }, undefined, undefined, ctx);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /https:\/\/api-docs.deepseek.com\//);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /A useful summary/);
  assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
  assert.equal(result.details.summary, "1 result");
});

test("empty results are successful, not errors", async () => {
  const result = await tools({ results: [] }).search.execute("test", { query: "nothing" }, undefined, undefined, ctx);
  assert.deepEqual(result.content, [{ type: "text", text: "No results found." }]);
  assert.equal(result.details.summary, "0 results");
});

test("fetch preserves Markdown and URL; schema matches", async () => {
  const tool = tools({ title: "Example", content: "# Heading\n\n**Markdown**" }).fetch;
  const result = await tool.execute("test", { url: "https://example.com" }, undefined, undefined, ctx);
  assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /https:\/\/example.com\n\n# Heading/);
});

test("large text is bounded, saved losslessly, with complete structured output", async () => {
  for (const text of ["中文内容\n".repeat(500), "中文😀".repeat(10_000)]) {
    const data = { title: "Long", content: text };
    const result = await toolResult(text, data, "Long");
    const file = result.details.fullOutputPath!;
    try {
      assert.ok(file);
      assert.equal(await readFile(file, "utf8"), text);
      assert.ok(Buffer.byteLength(result.content[0].text) < 32 * 1024);
      assert.ok(!result.content[0].text.includes("\uFFFD"));
      assert.match(result.content[0].text, /Output truncated/);
      assert.deepEqual(result.structuredContent, data);
    } finally { await rm(dirname(file), { recursive: true, force: true }); }
  }
});

test("rendering supports partial args, errors, expansion and old results", async () => {
  const tool = tools({ results: [item] }).search;
  const call = tool.renderCall!({} as never, theme, renderContext);
  assert.match(call.render(80).join("\n"), /DeepSeek Search/);
  const error = { content: [{ type: "text" as const, text: "HTTP 401: bad key" }], details: undefined };
  for (const isError of [true, false]) {
    assert.match(tool.renderResult!(error, { expanded: false, isPartial: false }, theme, { ...renderContext, isError }).render(80).join("\n"), /HTTP 401/);
  }
  const result = await tool.execute("test", { query: "test" }, undefined, undefined, ctx);
  const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext).render(80).join("\n");
  assert.match(collapsed, /1 result/);
  assert.ok(!collapsed.includes("A useful summary"));
  const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, renderContext).render(40).join("\n");
  assert.match(expanded, /A useful summary/);
});

test("untrusted terminal controls are stripped", () => {
  assert.equal(safeText("\x1b[31mred\x1b[0m\x00\x07\nnormal"), "red\nnormal");
});
