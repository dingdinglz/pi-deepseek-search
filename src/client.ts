import { setTimeout as delay } from "node:timers/promises";
import { Value } from "typebox/value";
import type { Static, TSchema } from "typebox";
import { FetchParams, FetchResponse, SearchParams, SearchResponse, type FetchInput, type SearchInput } from "./schemas.ts";

const BASE_URL = "https://api.deepseek.com/v1/tools";
const MAX_ATTEMPTS = 3;

export interface ClientOptions {
  apiKey?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  // Injectable to keep retry tests fast; production honors Retry-After.
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class DeepSeekClient {
  constructor(private readonly options: ClientOptions = {}) {}

  search(input: SearchInput, signal?: AbortSignal) {
    if (!Value.Check(SearchParams, input) || !input.query.trim() || Array.from(input.query).length > 128) {
      throw new Error("Invalid search parameters: query must contain 1–128 Unicode characters; count must be an integer from 1 to 50.");
    }
    // Pick known fields rather than forwarding arbitrary tool arguments.
    const { query, count = 10, need_content = false, ori_question, localization } = input;
    return this.request("search", { query, count, need_content, ori_question, localization }, SearchResponse, signal);
  }

  fetchPage(input: FetchInput, signal?: AbortSignal) {
    if (!Value.Check(FetchParams, input)) throw new Error("Invalid fetch parameters: provide a URL of at most 8192 characters.");
    let url: URL;
    try { url = new URL(input.url); } catch { throw new Error("Invalid URL: expected an absolute HTTP(S) URL."); }
    if (!/^https?:\/\//i.test(input.url) || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error("Invalid URL: use HTTP(S) with a host and no username or password.");
    }
    return this.request("fetch", { url: input.url }, FetchResponse, signal);
  }

  private async request<S extends TSchema>(endpoint: string, body: unknown, schema: S, callerSignal?: AbortSignal): Promise<Static<S>> {
    callerSignal?.throwIfAborted();
    const key = (await this.options.apiKey?.())?.trim();
    callerSignal?.throwIfAborted();
    if (!key) throw new Error("Run /deepseek-key in Pi's TUI to set your DeepSeek API key.");

    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
    const fetch = this.options.fetch ?? globalThis.fetch;
    const sleep = this.options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));

    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        signal.throwIfAborted();
        const response = await fetch(`${BASE_URL}/${endpoint}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal,
          redirect: "error",
        });
        const text = await response.text();
        let data: unknown;
        try { data = JSON.parse(text); } catch { /* Non-JSON errors get a safe generic message. */ }
        if (response.status === 200) {
          if (!Value.Check(schema, data)) throw new Error("DeepSeek returned an unexpected response schema.");
          return data;
        }

        const error = new Error(this.errorMessage(response.status, data, key));
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === MAX_ATTEMPTS - 1) throw error;
        const retryAfter = response.headers.get("retry-after");
        let wait = 500 * 2 ** attempt;
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(requested)) wait = Math.max(wait, requested);
        }
        // Do not retry sooner than requested, or extend the overall deadline.
        if (wait >= deadline - Date.now()) throw error;
        await sleep(wait, signal);
      }
      throw new Error("DeepSeek request failed.");
    } catch (error) {
      if (callerSignal?.aborted) throw new Error("DeepSeek request cancelled.");
      if (timeout.signal.aborted) throw new Error(`DeepSeek request timed out after ${timeoutMs / 1000}s.`);
      // A transport exception may contain request information; never leak the key.
      const message = error instanceof Error ? error.message : "DeepSeek request failed.";
      throw new Error(message.split(key).join("[REDACTED]"));
    } finally {
      clearTimeout(timer);
    }
  }

  private errorMessage(status: number, data: unknown, key: string): string {
    const hints: Record<number, string> = {
      400: "Check the request parameters.",
      401: "Run /deepseek-key to update your API key.",
      402: "DeepSeek account balance is insufficient; top up before retrying.",
      403: "Fetch was rejected by the safety policy.",
      404: "No usable page content; check the URL or try another source.",
      429: "Rate limit reached; retry later.",
    };
    let detail = "";
    if (data && typeof data === "object" && "error" in data) {
      const error = data.error;
      if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
        detail = error.message.split(key).join("[REDACTED]").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 300);
      }
    }
    return [`DeepSeek HTTP ${status}.`, hints[status], detail].filter(Boolean).join(" ");
  }
}
