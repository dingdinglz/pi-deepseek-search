import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createTools } from "../index.ts";
import { OpenAIClient, type OpenAIClientOptions } from "../src/openai-client.ts";
import { OpenAIResponse, type OpenAIFetchInput, type OpenAISearchInput } from "../src/openai-schemas.ts";

type Registry = ConstructorParameters<typeof OpenAIClient>[0];
type Model = NonNullable<ReturnType<Registry["find"]>>;
type Auth = Awaited<ReturnType<Registry["getApiKeyAndHeaders"]>>;
const endpoint = "https://chatgpt.com/backend-api/codex/alpha/search";
const modelId = "gpt-5.4";
const account = "synthetic-account_123";
const jwt = (payload: unknown) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic-signature`;
const tokenFor = (id: unknown) => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: id } });
const token = tokenFor(account);
const model = { id: modelId, provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://untrusted.invalid/override" } as Model;
const auth = (apiKey = token): Auth => ({ ok: true, apiKey, headers: { Authorization: "must-not-override-token", "chatgpt-account-id": "must-not-override-account" } }) as Auth;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function registry(overrides: Partial<Registry> = {}) {
  const calls = { find: [] as [string, string][], auth: [] as Model[] };
  const value: Registry = {
    getAll: () => [model],
    find(provider, id) { calls.find.push([provider, id]); return model; },
    async getApiKeyAndHeaders(selected) { calls.auth.push(selected); return auth(); },
    ...overrides,
  };
  return { value, calls };
}

function fixture(body: unknown = { output: "Direct service output" }, options: OpenAIClientOptions = {}) {
  const host = registry();
  const requests: { url: unknown; init: RequestInit | undefined }[] = [];
  const api = new OpenAIClient(host.value, modelId, {
    fetch: async (url, init) => { requests.push({ url, init }); return json(body); },
    ...options,
  });
  return { api, host, requests };
}

function assertRequest(request: { url: unknown; init: RequestInit | undefined }, commands: unknown) {
  assert.equal(request.url, endpoint);
  const init = request.init!;
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, {
    Authorization: `Bearer ${token}`, "chatgpt-account-id": account, originator: "pi",
    Accept: "application/json", "Content-Type": "application/json",
  });
  const body = JSON.parse(String(init.body));
  assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(body, {
    id: body.id, model: modelId, commands,
    settings: { external_web_access: true, allowed_callers: ["direct"] }, max_output_tokens: 6000,
  });
}

test("direct search uses fixed official origin, Codex auth, commands and defaults without model calls", async () => {
  const { api, host, requests } = fixture();
  assert.deepEqual(await api.search({ query: "Codex site:example.com" }), { provider: "openai", model: modelId, output: "Direct service output" });
  assert.equal(requests.length, 1);
  assertRequest(requests[0], { search_query: [{ q: "Codex site:example.com" }], response_length: "long" });
  assert.deepEqual(host.calls.find, [["openai-codex", modelId]]);
  assert.deepEqual(host.calls.auth, [model]);
});

test("search forwards recency/domains and response lengths, but not arbitrary args or conversation", async () => {
  const { api, requests } = fixture();
  for (const response_length of ["short", "medium", "long"] as const) {
    await api.search({
      query: "中文😀", recency: 7, domains: ["example.com", "docs.example.org"], response_length,
      messages: [{ role: "user", content: "private conversation" }], input: "private input",
      model: "attacker-model", endpoint: "https://untrusted.invalid", headers: { Authorization: "attacker" },
      settings: { external_web_access: false }, commands: { open: [{ ref_id: "attacker" }] }, count: 50,
    } as OpenAISearchInput);
    assertRequest(requests.at(-1)!, { search_query: [{ q: "中文😀", recency: 7, domains: ["example.com", "docs.example.org"] }], response_length });
  }
  assert.equal(new Set(requests.map(request => JSON.parse(String(request.init?.body)).id)).size, 3);
});

test("open sends the target URL only as a command, with default and explicit lineno", async () => {
  const { api, requests } = fixture();
  await api.fetchPage({ url: "https://example.com/article?x=1" });
  assertRequest(requests[0], { open: [{ ref_id: "https://example.com/article?x=1", lineno: 0 }], response_length: "long" });
  await api.fetchPage({ url: "http://example.org/page", lineno: 120, response_length: "medium", messages: ["private"], endpoint: "https://untrusted.invalid" } as OpenAIFetchInput);
  assertRequest(requests[1], { open: [{ ref_id: "http://example.org/page", lineno: 120 }], response_length: "medium" });
});

test("search accepts the 4000 Unicode code-point boundary", async () => {
  const { api, requests } = fixture();
  await api.search({ query: "😀".repeat(4000) });
  assert.equal(JSON.parse(String(requests[0].init?.body)).commands.search_query[0].q, "😀".repeat(4000));
});

for (const [label, extra] of [
  ["absent", {}], ["null", { results: null }], ["empty", { results: [] }],
  ["opaque", { results: [null, 3, "future variant", false, [1, 2], { type: "future", nested: { refs: ["https://example.com"] } }] }],
] as const) {
  test(`preserves output and ${label} result semantics; excludes encrypted output and synthetic usage`, async () => {
    const body = { output: "", ...extra, encrypted_output: "secret-opaque-ciphertext", usage: { total_tokens: 123 }, arbitrary: true };
    const { api } = fixture(body);
    const data = await api.search({ query: "x" });
    assert.deepEqual(data, { provider: "openai", model: modelId, output: "", ...("results" in body && Array.isArray(body.results) ? { results: body.results } : {}) });
    assert.ok(Value.Check(OpenAIResponse, data));
    assert.equal(Object.hasOwn(data, "encrypted_output"), false);
    assert.equal(Object.hasOwn(data, "usage"), false);
  });
}

test("malformed JSON and invalid response schemas fail instead of inventing results", async () => {
  await assert.rejects(fixture(undefined, { fetch: async () => new Response("not JSON") }).api.search({ query: "x" }), /invalid JSON/);
  for (const body of [null, [], {}, { output: null }, { output: 1 }, { output: "ok", results: {} }, { output: "ok", results: "bad" }]) {
    await assert.rejects(fixture(body).api.search({ query: "x" }), /unexpected response schema/);
  }
});

test("invalid search parameters fail before model lookup, auth or HTTP", () => {
  const { api, host, requests } = fixture();
  const inputs: unknown[] = [null, {}, { query: 1 }, ...["", " \n\t", "a".repeat(4001), "😀".repeat(4001)].map(query => ({ query })),
    ...[0, -1, 1.5, "7", null].map(recency => ({ query: "x", recency })),
    ...["example.com", [""], [7], null].map(domains => ({ query: "x", domains })),
    ...["huge", 1, null].map(response_length => ({ query: "x", response_length }))];
  for (const input of inputs) assert.throws(() => api.search(input as OpenAISearchInput), /Invalid OpenAI search parameters/);
  assert.deepEqual(host.calls, { find: [], auth: [] });
  assert.deepEqual(requests, []);
});

test("invalid URLs (including embedded credentials) and open parameters fail before auth or HTTP", () => {
  const { api, host, requests } = fixture();
  const inputs: unknown[] = [null, {}, { url: 1 },
    ...["", "nope", "file:///etc/passwd", "ftp://example.com", "https:example.com", "//example.com", "https://", "https://user:pass@example.com", "https://user@example.com", "https://:pass@example.com", "https://us%65r:pass@example.com", "https://example.com/" + "x".repeat(8192)].map(url => ({ url })),
    ...[-1, 1.5, "0", null].map(lineno => ({ url: "https://example.com", lineno })),
    { url: "https://example.com", response_length: "invalid" }];
  for (const input of inputs) assert.throws(() => api.fetchPage(input as OpenAIFetchInput), /Invalid fetch parameters/);
  assert.deepEqual(host.calls, { find: [], auth: [] });
  assert.deepEqual(requests, []);
});

test("auto uses a registered Codex model, skips other providers, and handles an empty catalog", async () => {
  const host = registry({ getAll: () => [{ ...model, provider: "openai", api: "openai-responses" } as Model, model] });
  const api = new OpenAIClient(host.value, "auto", { fetch: async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).model, modelId);
    return json({ output: "ok" });
  } });
  assert.equal((await api.search({ query: "x" })).model, modelId);
  assert.equal(host.calls.find.length, 0);
  const empty = registry({ getAll: () => [] });
  await assert.rejects(new OpenAIClient(empty.value, "auto").search({ query: "x" }), /unavailable/);
  assert.equal(empty.calls.auth.length, 0);
});

test("missing or wrong-api models fail before resolving auth", async () => {
  for (const selected of [undefined, { ...model, api: "openai-responses" } as Model]) {
    const host = registry({ find: () => selected });
    let requests = 0;
    const api = new OpenAIClient(host.value, modelId, { fetch: async () => { requests++; return json({ output: "unexpected" }); } });
    await assert.rejects(api.search({ query: "x" }), /unavailable.*\/web-provider openai/);
    assert.equal(host.calls.auth.length, 0);
    assert.equal(requests, 0);
  }
});

test("missing auth/API keys, API-key credentials and invalid JWT claims require login without HTTP", async () => {
  const credentials: Auth[] = [
    { ok: false } as Auth, { ok: true } as Auth, auth(""), auth("sk-synthetic-not-oauth"), auth("a.not-json.c"),
    auth(jwt({ chatgpt_account_id: account })), auth(jwt({ "https://api.openai.com/auth": {} })),
    ...[null, 42, "", "bad/account", "account\r\nInjected: yes"].map(id => auth(tokenFor(id))),
  ];
  for (const credential of credentials) {
    let requests = 0;
    const host = registry({ getApiKeyAndHeaders: async () => credential });
    const api = new OpenAIClient(host.value, modelId, { fetch: async () => { requests++; return json({ output: "unexpected" }); } });
    await assert.rejects(api.search({ query: "x" }), /\/login.*openai-codex/);
    assert.equal(requests, 0);
  }
});

test("host auth resolver failures are redacted", async () => {
  const host = registry({ getApiKeyAndHeaders: async () => { throw new Error(`refresh failed ${token} ${account}`); } });
  const api = new OpenAIClient(host.value, modelId, { fetch: async () => { assert.fail("must not request"); } });
  await assert.rejects(api.search({ query: "x" }), error => {
    assert.equal(String(error), "Error: Cannot resolve Codex credentials. Run /login and choose openai-codex.");
    return true;
  });
});

test("host auth refresh resolver is invoked on every request; refreshed token/account are used", async () => {
  let resolutions = 0;
  const host = registry({ getApiKeyAndHeaders: async () => auth(tokenFor(`refreshed_${++resolutions}`)) });
  const headers: Headers[] = [];
  const api = new OpenAIClient(host.value, modelId, { fetch: async (_url, init) => { headers.push(new Headers(init?.headers)); return json({ output: "ok" }); } });
  await api.search({ query: "x" });
  await api.fetchPage({ url: "https://example.com" });
  assert.equal(resolutions, 2);
  assert.deepEqual(host.calls.find, [["openai-codex", modelId], ["openai-codex", modelId]]);
  for (const [index, header] of headers.entries()) {
    assert.equal(header.get("Authorization"), `Bearer ${tokenFor(`refreshed_${index + 1}`)}`);
    assert.equal(header.get("chatgpt-account-id"), `refreshed_${index + 1}`);
  }
});

for (const status of [400, 401, 402, 403, 404, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} never retries/falls back or leaks reflected credentials`, async t => {
    t.mock.method(globalThis, "fetch", async () => { assert.fail("no global fetch/provider fallback"); });
    let calls = 0;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`error-body-marker ${token} ${account}`)); },
      cancel() { cancelled = true; },
    }), { status, headers: { "Retry-After": "0" } });
    const { api, host } = fixture(undefined, { fetch: async () => { calls++; return response; } });
    await assert.rejects(api.search({ query: "x" }), error => {
      const text = String(error);
      assert.match(text, new RegExp(`OpenAI Codex HTTP ${status}\\.`));
      assert.match(text, /No automatic provider fallback/);
      for (const secret of [token, account, "error-body-marker"]) assert.ok(!text.includes(secret));
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(host.calls.auth.length, 1);
    assert.equal(host.calls.find.length, 1);
    assert.equal(cancelled, true);
  });
}

test("transport errors redact secrets without retries, including known-error-prefix exceptions", async () => {
  for (const message of [`connection failed Authorization: Bearer ${token} ${account}`, `OpenAI Codex HTTP failure ${token} ${account}`]) {
    let calls = 0;
    const { api } = fixture(undefined, { fetch: async () => { calls++; throw new Error(message); } });
    await assert.rejects(api.search({ query: "x" }), error => {
      const text = String(error);
      assert.ok(!text.includes(token));
      assert.ok(!text.includes(account));
      assert.match(text, /network or transport error|\[REDACTED\]/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("pre-aborted search/open do not resolve models/auth or send HTTP", async () => {
  const { api, host, requests } = fixture();
  const signal = AbortSignal.abort();
  await assert.rejects(api.search({ query: "x" }, signal), { name: "AbortError" });
  await assert.rejects(api.fetchPage({ url: "https://example.com" }, signal), { name: "AbortError" });
  assert.deepEqual(host.calls, { find: [], auth: [] });
  assert.deepEqual(requests, []);
});

test("cancellation during host auth resolution prevents HTTP", async () => {
  const controller = new AbortController();
  const host = registry({ getApiKeyAndHeaders: async () => { controller.abort(); return auth(); } });
  let requests = 0;
  const api = new OpenAIClient(host.value, modelId, { fetch: async () => { requests++; return json({ output: "unexpected" }); } });
  await assert.rejects(api.search({ query: "x" }, controller.signal), { name: "AbortError" });
  assert.equal(requests, 0);
});

function hangingFetch(onStart: (signal: AbortSignal) => void): typeof fetch {
  return async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener("abort", () => reject(new Error(`transport abort ${token} ${account}`)), { once: true });
    onStart(signal);
  });
}

test("in-flight caller cancellation aborts underlying HTTP without retry", async () => {
  const controller = new AbortController();
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  const { api } = fixture(undefined, { fetch: hangingFetch(signal => { calls++; requestSignal = signal; controller.abort(); }) });
  await assert.rejects(api.fetchPage({ url: "https://example.com" }, controller.signal), /^Error: OpenAI web request cancelled\.$/);
  assert.equal(calls, 1);
  assert.equal(requestSignal?.aborted, true);
});

test("timeout aborts underlying HTTP and does not retry", async () => {
  // The production deadline is unref'ed; keep this isolated test alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000);
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  try {
    const { api } = fixture(undefined, { timeoutMs: 10, fetch: hangingFetch(signal => { calls++; requestSignal = signal; }) });
    await assert.rejects(api.search({ query: "x" }), /^Error: OpenAI web request timed out after 0\.01s\.$/);
    assert.equal(calls, 1);
    assert.equal(requestSignal?.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test("OpenAI tools use only ctx.modelRegistry and direct HTTP, validate outputSchema and report no fake usage", async t => {
  const host = registry();
  const ctx = {
    modelRegistry: host.value,
    get sessionManager() { return assert.fail("must not read user conversation"); },
    get model() { return assert.fail("must not use conversation model"); },
  } as unknown as ExtensionToolContext;
  const requests: { url: unknown; init: RequestInit | undefined }[] = [];
  const output = "L12: A source https://example.com/page";
  const results = [{ type: "future_result", payload: { arbitrary: [1, null] } }];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    requests.push({ url, init });
    return json({ output, results, encrypted_output: "must-not-surface", usage: { total_tokens: 999 } });
  });
  const tools = createTools(undefined, () => ({ provider: "openai", model: modelId }));
  const search = await tools.search.execute("search", { query: "source", recency: 2 }, undefined, undefined, ctx);
  const page = await tools.fetch.execute("open", { url: "https://example.com/page", lineno: 12, response_length: "short" }, undefined, undefined, ctx);
  assert.equal(requests.length, 2);
  assertRequest(requests[0], { search_query: [{ q: "source", recency: 2 }], response_length: "long" });
  assertRequest(requests[1], { open: [{ ref_id: "https://example.com/page", lineno: 12 }], response_length: "short" });
  assert.equal(host.calls.auth.length, 2);
  for (const [tool, result] of [[tools.search, search], [tools.fetch, page]] as const) {
    assert.ok(Value.Check(tool.outputSchema!, result.structuredContent));
    assert.deepEqual(result.structuredContent, { output, results });
    assert.equal(result.content[0].type, "text");
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.match(text, /Retrieved web content; may be a partial excerpt/);
    assert.ok(text.includes(output));
    assert.ok(!JSON.stringify(result).includes("must-not-surface"));
    for (const object of [result, result.details, result.structuredContent!]) {
      for (const key of ["usage", "cost", "totalTokens", "inputTokens", "outputTokens"]) assert.equal(Object.hasOwn(object, key), false);
    }
  }
});

test("tools keep empty results successful and forward cancellation", async t => {
  const host = registry();
  const ctx = { modelRegistry: host.value } as unknown as ExtensionToolContext;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({ output: "", results: [] }); });
  const tools = createTools(undefined, () => ({ provider: "openai", model: modelId }));
  const result = await tools.search.execute("empty", { query: "x" }, undefined, undefined, ctx);
  assert.ok(Value.Check(tools.search.outputSchema!, result.structuredContent));
  assert.deepEqual(result.structuredContent, { output: "", results: [] });
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /No content returned/);
  await assert.rejects(tools.fetch.execute("aborted", { url: "https://example.com" }, AbortSignal.abort(), undefined, ctx));
  assert.equal(calls, 1);
  assert.equal(host.calls.auth.length, 1);
});
