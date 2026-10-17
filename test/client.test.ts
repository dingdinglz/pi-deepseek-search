import assert from "node:assert/strict";
import { test } from "node:test";
import { DeepSeekClient, type ClientOptions } from "../src/client.ts";

const key = "test-secret-do-not-log";
const page = { title: "Example", content: "# Example\n\nHello." };
const search = { results: [] };
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function client(fetch: ClientOptions["fetch"], rest: ClientOptions = {}) {
  return new DeepSeekClient({ apiKey: () => key, fetch, ...rest });
}

test("search uses the documented endpoint, auth and defaults", async () => {
  const api = client(async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "DeepSeek site:github.com", count: 10, need_content: false });
    return json(search);
  });
  assert.deepEqual(await api.search({ query: "DeepSeek site:github.com" }), search);
});

test("forwards all optional search fields and supports Unicode code points", async () => {
  const input = { query: "😀".repeat(128), count: 50, need_content: true, ori_question: null, localization: "1.1.1.1" };
  const api = client(async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), input);
    return json(search);
  });
  await api.search(input);
});

test("fetch posts a single URL", async () => {
  const api = client(async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/v1/tools/fetch");
    assert.deepEqual(JSON.parse(String(init?.body)), { url: "https://example.com/" });
    return json(page);
  });
  assert.deepEqual(await api.fetchPage({ url: "https://example.com/" }), page);
});

test("invalid input never sends a request", async () => {
  const api = client(async () => { throw new Error("should not request"); });
  for (const query of ["", "  \n", "😀".repeat(129)]) {
    assert.throws(() => api.search({ query }), /Invalid search/);
  }
  for (const count of [0, 51, 1.5]) assert.throws(() => api.search({ query: "x", count }), /Invalid search/);
  for (const url of ["file:///etc/passwd", "https://user:pass@example.com", "ftp://example.com", "nope", "https:example.com", "https://x/" + "x".repeat(8192)]) {
    assert.throws(() => api.fetchPage({ url }), /Invalid/);
  }
});

test("missing key gives setup instructions without networking", async () => {
  const api = client(async () => { throw new Error("should not request"); }, { apiKey: () => "  " });
  await assert.rejects(api.search({ query: "test" }), /Set DEEPSEEK_API_KEY/);
});

for (const status of [400, 401, 402, 403, 404, 413]) {
  test(`HTTP ${status} is actionable and never retried`, async () => {
    let calls = 0;
    const api = client(async () => { calls++; return json({ error: { message: `failed ${key}` } }, status); });
    await assert.rejects(api.search({ query: "test" }), error => {
      assert.match(String(error), new RegExp(`HTTP ${status}`));
      assert.ok(!String(error).includes(key));
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const status of [408, 429, 500, 502, 504]) {
  test(`retries HTTP ${status}, respects Retry-After, then succeeds`, async () => {
    let calls = 0;
    const waits: number[] = [];
    const api = client(async () => ++calls === 1 ? json({}, status, { "Retry-After": "2" }) : json(page), {
      sleep: async ms => { waits.push(ms); },
    });
    assert.deepEqual(await api.fetchPage({ url: "https://example.com" }), page);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2000]);
  });
}

test("retries are bounded and long Retry-After is not ignored", async () => {
  let calls = 0;
  const api = client(async () => { calls++; return json({}, 500); }, { sleep: async () => {} });
  await assert.rejects(api.search({ query: "x" }), /HTTP 500/);
  assert.equal(calls, 3);
  const limited = client(async () => json({}, 429, { "Retry-After": "120" }), {
    sleep: async () => { assert.fail("must not retry early"); },
  });
  await assert.rejects(limited.search({ query: "x" }), /HTTP 429/);
});

test("rejects malformed successful responses and non-JSON errors", async () => {
  for (const body of [{ results: [{}] }, { wrong: true }]) {
    await assert.rejects(client(async () => json(body)).search({ query: "x" }), /unexpected response schema/);
  }
  await assert.rejects(client(async () => new Response("<html>error</html>", { status: 401 })).search({ query: "x" }), /HTTP 401/);
  await assert.rejects(client(async () => new Response("not json")).search({ query: "x" }), /unexpected response schema/);
});

const pendingFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});

test("caller cancellation aborts HTTP and retry waits", async () => {
  const controller = new AbortController();
  const promise = client(pendingFetch).search({ query: "x" }, controller.signal);
  controller.abort();
  await assert.rejects(promise, /cancelled/);

  const retryController = new AbortController();
  const retry = client(async () => json({}, 429), {
    sleep: async (_ms, signal) => { retryController.abort(); signal.throwIfAborted(); },
  });
  await assert.rejects(retry.search({ query: "x" }, retryController.signal), /cancelled/);
});

test("pre-aborted calls do not access the network", async () => {
  const api = client(async () => { assert.fail("must not request"); });
  await assert.rejects(api.search({ query: "x" }, AbortSignal.abort()));
});

test("overall deadline aborts the underlying request", async () => {
  // Keep the test event loop alive; the production timeout deliberately uses unref().
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(client(pendingFetch, { timeoutMs: 10 }).search({ query: "x" }), /timed out/);
  } finally { clearTimeout(keepAlive); }
});

test("transport errors are redacted and not automatically retried", async () => {
  let calls = 0;
  const api = client(async () => { calls++; throw new Error(`network failure ${key}`); });
  await assert.rejects(api.search({ query: "x" }), error => {
    assert.match(String(error), /network failure \[REDACTED\]/);
    return true;
  });
  assert.equal(calls, 1);
});
